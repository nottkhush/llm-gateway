import { Router } from "express";
import { pool } from "../db";
import { auth } from "../middleware/auth";
import { PRICES, DEFAULT_MODEL, cost } from "../pricing";
import { callWithFallback, ProviderError } from "../providers";

export const chat = Router();

const PROMPT_OVERHEAD = 100; // CHANGE 1: chat-template tokens Groq adds
const MAX_OUT = 2048;        // CHANGE 2: cap on client-supplied max_tokens

chat.post("/chat/completions", auth, async (req, res) => {
  const keyId: number = res.locals.apiKey.id;
  const { messages, model = DEFAULT_MODEL, max_tokens = 1024, stream } = req.body || {};

  if (stream) return res.status(400).json({ error: "streaming not supported" });
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages[] required" });
  if (!PRICES[model] || model === "mock-1")
    return res.status(400).json({ error: `unsupported model, use: ${DEFAULT_MODEL}` });

  // CHANGE 2: validate max_tokens BEFORE computing the estimate
  if (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > MAX_OUT)
    return res.status(400).json({ error: `max_tokens must be an integer 1-${MAX_OUT}` });

  // CHANGE 1: conservative upper bound (chars/3 + overhead instead of chars/4)
  const estIn = Math.ceil(JSON.stringify(messages).length / 3) + PROMPT_OVERHEAD;
  const estimate = cost(model, estIn, max_tokens);

  // atomic reserve: only succeeds if budget still covers it
  const reserve = await pool.query(
    `UPDATE api_keys SET spent_micros = spent_micros + $2
     WHERE id = $1 AND spent_micros + $2 <= budget_micros
     RETURNING id`,
    [keyId, estimate]
  );
  if (reserve.rowCount === 0)
    return res.status(402).json({ error: "budget exceeded" });

  const started = Date.now();

  // CHANGE 3a: only the provider call triggers a refund
  let r: Awaited<ReturnType<typeof callWithFallback>>;
  try {
    r = await callWithFallback(model, messages, max_tokens);
  } catch (e) {
    await pool.query(
      "UPDATE api_keys SET spent_micros = spent_micros - $2 WHERE id = $1",
      [keyId, estimate]
    );
    await pool.query(
      `INSERT INTO usage_logs (key_id, provider, model, status, latency_ms)
       VALUES ($1,'groq',$2,'error',$3)`,
      [keyId, model, Date.now() - started]
    );
    const isClient = e instanceof ProviderError && !e.retryable;
    return res.status(isClient ? 400 : 502).json({ error: (e as Error).message });
  }

  const actual = cost(r.model, r.tokensIn, r.tokensOut);

  // CHANGE 3b: settle failure does NOT refund (we already paid the provider)
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE api_keys SET spent_micros = spent_micros - $2 + $3 WHERE id = $1",
        [keyId, estimate, actual]
      );
      await client.query(
        `INSERT INTO usage_logs
         (key_id, provider, model, tokens_in, tokens_out, cost_micros, status, latency_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [keyId, r.provider, r.model, r.tokensIn, r.tokensOut, actual,
         r.provider === "mock" ? "fallback" : "ok", Date.now() - started]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("settle failed, reservation left in place", { keyId, estimate, actual, err: e });
  }

  res.json({
    provider: r.provider,
    model: r.model,
    choices: [{ message: { role: "assistant", content: r.content } }],
    usage: { prompt_tokens: r.tokensIn, completion_tokens: r.tokensOut, cost_micros: actual },
  });
});