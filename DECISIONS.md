# DECISIONS.md

**Live URL:** https://llm-gateway-givj.onrender.com (Render free tier: the first request after idle can take 30-60s)

```bash
curl -s -X POST https://llm-gateway-givj.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer <GATEWAY_KEY>" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":50}'
```

## What I built

A small LLM gateway in TypeScript (Express + Postgres on Neon) that sits in front of Groq (`openai/gpt-oss-20b`). Callers use gateway-issued virtual keys (`gw_...`); the provider key lives only in server environment variables. Each key has a budget in micro-USD that is enforced before the provider call, every request is logged with tokens, cost, status and latency, and provider failures go through a retry-then-mock fallback. Admin endpoints create keys and report spend. No boilerplate was used; I wrote it with AI assistance (see AI-LOG.md).

## Moving parts and request lifecycle

```
client
  │  POST /v1/chat/completions  (Authorization: Bearer gw_...)
  ▼
auth middleware ── sha256(key) ── lookup api_keys by key_hash ── 401 if missing/unknown
  ▼
validate body ── messages[] non-empty, model supported, max_tokens integer 1-2048,
                 no stream ── 400 if invalid
  ▼
estimate worst-case cost = price(est. input tokens, max_tokens)
  est. input tokens = ceil(len(JSON(messages)) / 3) + 100   (deliberately pessimistic)
  ▼
atomic reserve in Postgres:
  UPDATE api_keys SET spent_micros = spent_micros + $est
  WHERE id = $id AND spent_micros + $est <= budget_micros
  0 rows updated ── 402 "budget exceeded" (no provider call is made)
  ▼
callWithFallback ── Groq, 10s timeout, up to 2 attempts on retryable errors
                 ── still failing ── mock response (cost 0)
                 ── non-retryable 4xx ── refund reservation, log error row, 400
  ▼
actual cost = price(provider-reported tokens in/out)   (static price table)
  ▼
one DB transaction: spent_micros = spent_micros - estimate + actual,
                    INSERT INTO usage_logs (...)       ── COMMIT
  ▼
response { provider, model, choices, usage{prompt_tokens, completion_tokens, cost_micros} }
```

Endpoints: `POST /v1/chat/completions`, `GET /v1/whoami` (key info), `POST /admin/keys` (body `{name, budgetUsd}`) and `GET /usage?key_id=` (both need `x-admin-token`).

Tables: `api_keys` (key_hash, key_prefix, budget_micros, spent_micros) and `usage_logs` (key_id, provider, model, tokens_in, tokens_out, cost_micros, status, latency_ms, created_at). Status is `ok`, `fallback` (mock served) or `error`.

## Key decisions

1. **Non-streaming responses.** Options: streaming (SSE) or a single JSON response. I chose non-streaming because cost is known exactly from the provider's usage field once the call completes, which keeps budget and logging logic simple and correct. Tradeoff: higher perceived latency for long outputs, and not drop-in compatible with clients that expect streams. `stream: true` is rejected with a 400.

2. **Budget in integer micro-USD, stored on the key row.** Options: request counts, tokens, or currency. I chose cost because it is what the team actually pays for and it normalises across models. Stored as `BIGINT` micro-dollars to avoid float rounding, with `spent_micros` on the same row as `budget_micros` so the check and the increment are one atomic SQL statement. Tradeoff: cost comes from a static price table in `pricing.ts`, which drifts if provider prices change.

3. **Keys are hashed at rest.** Options: store raw keys, encrypt, or store a hash. I store a SHA-256 hash plus a short prefix for display, and show the raw key only once at creation. A database leak therefore does not expose usable keys. Tradeoff: a lost key cannot be recovered, only reissued.

4. **Reserve worst-case cost before the call, settle after.** Options: check-then-spend (racy), a row lock held for the whole provider call (slow, ties up a connection), or reserve then settle. I chose reserve then settle. Before calling the provider, the gateway adds an estimated worst-case cost (estimated input tokens plus the full `max_tokens` output) to `spent_micros` in a single conditional `UPDATE`. After the call it replaces the estimate with the real cost. If the provider call fails outright, the reservation is refunded. Tradeoff: it is pessimistic, so a request can be rejected while actual spend is still under the cap, and the input-token estimate is a heuristic (`chars / 3 + 100`), not a real tokenizer.

5. **Logging is synchronous, and in the same transaction as settlement.** Options: write the log row after responding (or via a queue), or write it inline. I chose inline: the spend update and the `usage_logs` insert commit together, so a request's spend and its log row either both exist or neither does, and no row is lost on a crash. Tradeoff: it adds a database round trip to every request's latency, and a slow database slows responses. Asynchronous logging would be faster but can drop rows if the process dies.

## Why enforce budgets at the gateway

A caller can only be trusted to limit itself if it is correct, honest and not compromised, and a leaked key or a buggy retry loop breaks all three. The gateway is the only place that sees every request and holds the real provider credential, so it is the only place a limit cannot be bypassed. It also gives one consistent number for spend across callers, instead of each client estimating its own.

## Concurrency

I handled it. The check and the spend are one conditional `UPDATE ... WHERE spent_micros + $est <= budget_micros`, so Postgres serialises concurrent reservations on the key's row and two requests cannot both claim the last of the budget. I tested it with six parallel requests on a key with a 100 µ$ budget:

| Version | Where | Parallel requests | Outcome | Spent |
|---|---|---|---|---|
| Check-then-spend | local | 6 | all 200 | 113 µ$ (over the 100 cap) |
| Atomic reserve/settle | local | 6 | 4× 200, 2× 402 | 72 µ$ (under the cap) |
| Atomic reserve/settle | deployed on Render | 6 | 4× 200, 2× 402 | 75 µ$ (under the cap) |

The first row is the race: all requests passed the check before any recorded spend. Accepted tradeoffs: reservations can reject a request early, and because the input estimate is a heuristic, the final settled cost could in principle exceed the estimate if the estimate under-counts tokens. The output side is bounded by `max_tokens` (capped at 2048), and the input estimate is deliberately pessimistic, so any overshoot is small but not strictly zero.

## Fallback policy

- **Timeout:** 10 seconds per Groq attempt.
- **Retries:** up to 2 attempts, back to back with no backoff.
- **What counts as retryable:** network errors and timeouts, HTTP 5xx, and HTTP 429.
- **What does not:** other 4xx responses. These are not retried and not masked: the reservation is refunded, an `error` row is logged, and the caller gets a 400 with the message.
- **If both attempts fail:** the gateway returns a clearly labelled mock response (`provider: "mock"`, content starting with `[fallback]`), costing 0, so the reservation is fully released. It is logged with status `fallback`. The HTTP status is 200.
- **Second provider:** a mock, not a second real provider. The brief allows this, and I chose it so callers never hang and a failed call is never billed.

Why: retry only on errors that are likely transient, never on caller errors, and never bill for a call that did not produce a real answer. Worst-case latency before the mock is returned is about 20 seconds.

## What I deliberately did not build

- Streaming responses (see decision 1).
- Caching and semantic caching: no stretch item attempted, to keep the core solid.
- A UI: the brief says it is not scored.
- Multi-tenant auth beyond simple keys, key rotation and expiry.
- Automated tests: a deliberate cut. I verified behaviour with manual curl tests, including the parallel budget test above, run both locally and against the deployed URL.
- Live price lookups: prices are a static table.
- A second real provider, backoff between retries, and per-key rate limits.

## The decision I'm least confident about

**Returning HTTP 200 with a mock answer when the provider is down, instead of an error.**

For: callers never hang or crash, the response clearly says `provider: "mock"`, nothing is billed, and the brief lists a local or mock model as an acceptable fallback. A demo keeps working during a provider outage.

Against: a client that does not inspect the `provider` field will treat the placeholder text as a real model answer, which is silent corruption of whatever downstream logic uses it. A 503 is more honest and lets callers' own retry logic and alerting work. The mock also hides provider outages from anyone who only watches status codes.

I picked 200-with-mock for resilience, but I would change it to a 503 by default and make the mock an opt-in for a real deployment. A second candidate for this slot is the static price table versus provider-reported cost: simple and deterministic, but silently wrong when prices change or a model is missing from the table.

## Where it breaks, and one more week

- Free-tier hosting sleeps when idle and has no horizontal scaling story.
- Prices are static and can drift.
- A crash between reserve and settle strands the reservation: that key's `spent_micros` stays over-counted until someone fixes it. The same happens if the settle transaction fails (it logs the error and leaves the reservation in place on purpose, since the provider was already paid). Spend can be over-counted this way but not under-counted.
- Database errors at the reserve step are not caught inside the handler. Depending on the Express version, that is either a generic 500 or an unhandled promise rejection, which should be wrapped.
- Retries have no backoff, so a 429 from Groq is retried immediately and may fail again.
- A bad or revoked server-side Groq key surfaces to the caller as a 400, which blames the caller for a server fault.
- The error-path log row hardcodes provider `groq` and has no token or cost data.
- Admin auth is a single shared token with no audit trail.
- No rate limiting per key, only budget.

With another week: a reconciliation job for stranded reservations, a try/catch (or async wrapper) around every handler, a second real provider with health-based routing and backoff, 503 instead of mock by default, streaming with post-hoc settlement, per-key rate limits, tests around the budget path, and key rotation.