import { config } from "./config";

export type Msg = { role: string; content: string };
export type ProviderResult = {
  provider: string;
  model: string;
  content: string;
  tokensIn: number;
  tokensOut: number;
};

export class ProviderError extends Error {
  constructor(msg: string, public retryable: boolean) {
    super(msg);
  }
}

async function groq(model: string, messages: Msg[], maxTokens: number): Promise<ProviderResult> {
  let r: Response;
  try {
    r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.groqKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    throw new ProviderError(`network/timeout: ${e.message}`, true);
  }
  if (!r.ok) {
    const retryable = r.status >= 500 || r.status === 429;
    throw new ProviderError(`groq ${r.status}`, retryable);
  }
  const j: any = await r.json();
  return {
    provider: "groq",
    model,
    content: j.choices?.[0]?.message?.content ?? "",
    tokensIn: j.usage?.prompt_tokens ?? 0,
    tokensOut: j.usage?.completion_tokens ?? 0,
  };
}

// last-resort fallback so callers get a clear degraded answer, not a hang
async function mock(_messages: Msg[]): Promise<ProviderResult> {
  return {
    provider: "mock",
    model: "mock-1",
    content: "[fallback] primary provider unavailable, this is a mock response.",
    tokensIn: 0,
    tokensOut: 0,
  };
}

export async function callWithFallback(
  model: string,
  messages: Msg[],
  maxTokens: number
): Promise<ProviderResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await groq(model, messages, maxTokens);
    } catch (e) {
      const err = e as ProviderError;
      if (!err.retryable) throw err; // 4xx: caller's fault, don't mask it
      console.warn(`groq attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  return mock(messages);
}
