import type { Usage } from "./agent.ts";

/** USD per million tokens. DeepSeek bills half of this off-peak. Checked 2026-10-01; prices change. */
export const PRICES: Record<string, { input: number; cacheRead: number; output: number }> = {
  "deepseek-flash": { input: 0.3, cacheRead: 0.006, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, cacheRead: 0.044, output: 3.96 },
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, output: 20 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.2, output: 10 },
};

/** What a model's usage cost, or undefined for a model without a price. Cache writes count as input. */
export function costOf(model: string, usage: Usage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  return ((usage.input + usage.cacheWrite) * price.input + usage.cacheRead * price.cacheRead + usage.output * price.output) / 1e6;
}
