// micro-USD per 1M tokens
export const PRICES: Record<string, { in: number; out: number }> = {
  "openai/gpt-oss-20b": { in: 75_000, out: 300_000 },
  "mock-1": { in: 0, out: 0 },
};

export const DEFAULT_MODEL = "openai/gpt-oss-20b";

export function cost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return Math.ceil((tokensIn * p.in + tokensOut * p.out) / 1_000_000);
}
