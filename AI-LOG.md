# AI-LOG.md

> Draft. Lines marked `TODO` need your own words and facts. The reviewers will ask you about this, so write what actually happened. Delete this line when done.

## Tools and models used

- **Claude (claude.ai chat):** `TODO: which model(s)`. Used for the initial architecture, writing most of the TypeScript, debugging the build, designing the schema and the budget logic, and drafting these documents.
- `TODO: any other tools, e.g. Copilot, Cursor, ChatGPT`.
- Provider used by the gateway itself: Groq, model `openai/gpt-oss-20b`.

## One place the AI was wrong

The AI gave me a `tsconfig.json` with `"moduleResolution": "node"`. My installed TypeScript version had removed that option (error TS5108: `moduleResolution=node10` has been removed), so the build failed. I caught it because I ran `npm run build` and read the error instead of assuming the config was fine. The AI also pointed out that the `dist/` folder I could see had been emitted despite the error, so it could not be trusted; I deleted it and rebuilt clean.

A related miss: my original `tsconfig` had `outDir` commented out, so a failed `tsc` run wrote about 40 `.js`, `.d.ts` and `.map` files into `src/`. I noticed the file count looked wrong, listed `src/`, deleted the output, and set `rootDir` and `outDir` explicitly before committing.

## One place I overrode the AI

`TODO: write a real one.` Candidates, only if true for you:
- You chose a design or setting over what the AI suggested, for example keeping or dropping a stricter TypeScript option, budget unit, or fallback behaviour.
- You rejected an extra feature (caching, streaming, a UI) the AI offered, to protect the core.

State what the AI suggested, what you did instead, and why.

## How I stayed in control of code I didn't type

- **Secrets:** the provider key and admin token exist only as environment variables. `.env` is in `.gitignore`, and I checked `git log --all -- .env` returned nothing and `git status` before committing. User keys are stored as hashes.
- **Budget logic:** I did not trust it on reading. I wrote a parallel test (six simultaneous requests on a 100 µ$ budget). The first implementation overspent (113 µ$ spent against a 100 cap), which showed the race was real. After the fix, the same test produced 4× 200 and 2× 402 with 72 µ$ spent.
- **Provider call:** `TODO: describe, e.g. read providers.ts line by line, tested a bad key / timeout to see the fallback path.`
- **Input validation:** I tested bad input directly, for example `max_tokens: -5` returns a 400 with a clear message.
- I only kept code I can explain in the walkthrough.

## Something I learned from scratch

`TODO: pick the real one.` Possible candidates from this build, if they were new to you:
- Atomic budget enforcement in Postgres and why check-then-spend races under concurrency.
- How TypeScript module settings interact with `package.json` (`"type"`, `nodenext`, `verbatimModuleSyntax`), and why `tsx` hides errors that `tsc` shows.
- Deploying a compiled Node service on Render, including copying non-code files like `schema.sql` into `dist/`.

Describe how you got up to speed (docs, experiments, asking the AI to explain, then verifying).
