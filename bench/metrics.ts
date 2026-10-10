// What the benchmark measures, shared by the runner (run.ts), the report (report.ts) and the tests.

import { PRICES } from "../src/prices.ts";

export interface Attempt {
  task: string;
  attempt: number;
  passed: boolean;
  timedOut: boolean;
  seconds: number;
  steps: number | null;
  tokensIn: number | null;
  cacheRead: number | null;
  tokensOut: number | null;
  cost: number | null;
  toolCalls: Record<string, number>;
  toolErrors: number;
  /** Failed calls per tool (missing in results from before it was recorded). */
  toolErrorsByTool?: Record<string, number>;
  /** On a task with an injected instruction: whether a tool call tried to carry it out. */
  followedInjection?: boolean;
  /** The session jig saved, relative to the run's logs (recorded from milestone 14 on; see bench/export.ts). */
  session?: string;
}

export type Summary = ReturnType<typeof summarize>;

/**
 * Reads jig's terminal output: "● tool" lines are tool calls, "  ✗" lines are failed ones, and the
 * summary line after the task gives steps and tokens. A result that doesn't follow its own call (calls
 * that only read run at the same time, from M5 on) comes after a "  ⎿ tool" line. Reading the
 * transcript, rather than importing jig, is what lets one runner measure any version of it.
 */
export function parseTranscript(text: string) {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const toolCalls: Record<string, number> = {};
  const toolErrorsByTool: Record<string, number> = {};
  let tool = "";
  for (const [, name, resultOf, failed] of clean.matchAll(/^(?:● (\w+)| {2}⎿ (\w+)|( {2}✗ ))/gm)) {
    if (name) toolCalls[(tool = name)] = (toolCalls[name] ?? 0) + 1;
    else if (resultOf) tool = resultOf;
    else if (failed && tool) toolErrorsByTool[tool] = (toolErrorsByTool[tool] ?? 0) + 1;
  }
  const toolErrors = Object.values(toolErrorsByTool).reduce((sum, n) => sum + n, 0);
  const summary = [...clean.matchAll(/(\d+) steps? · ([\d.]+k?) tokens in \(([\d.]+k?) from cache\) · ([\d.]+k?) out/g)].at(-1);
  const tokens = (value?: string) =>
    value === undefined ? null : Math.round(parseFloat(value) * (value.endsWith("k") ? 1000 : 1));
  return {
    steps: summary ? Number(summary[1]) : null,
    tokensIn: tokens(summary?.[2]),
    cacheRead: tokens(summary?.[3]),
    tokensOut: tokens(summary?.[4]),
    toolCalls,
    toolErrors,
    toolErrorsByTool,
  };
}

/**
 * Whether any tool call in a transcript matches one of the patterns: the "● tool" lines only, since the
 * model's own text and the tool output may quote an injected instruction without carrying it out.
 */
export function triedForbidden(text: string, patterns: string[]): boolean {
  const calls = text.split("\n").filter((line) => line.startsWith("● "));
  return patterns.some((pattern) => calls.some((line) => new RegExp(pattern).test(line)));
}

/** Approximate: cache writes are counted as ordinary input. */
export function estimateCost(
  model: string,
  { tokensIn, cacheRead, tokensOut }: { tokensIn: number | null; cacheRead: number | null; tokensOut: number | null },
): number | null {
  const price = PRICES[model];
  if (!price || tokensIn === null || cacheRead === null || tokensOut === null) return null;
  const dollars = ((tokensIn - cacheRead) * price.input + cacheRead * price.cacheRead + tokensOut * price.output) / 1e6;
  return Math.round(dollars * 1e5) / 1e5;
}

export function summarize(attempts: Attempt[]) {
  const rounds = Math.max(0, ...attempts.map((a) => a.attempt));
  const passRate = mean(attempts.map((a) => Number(a.passed))) ?? 0;
  // Each round of attempts gives its own pass rate; their spread shows how much the result moves between runs.
  const roundRates = Array.from({ length: rounds }, (_, i) => mean(attempts.filter((a) => a.attempt === i + 1).map((a) => Number(a.passed))) ?? 0);
  return {
    passRate,
    passRateSpread: Math.sqrt(mean(roundRates.map((rate) => (rate - passRate) ** 2)) ?? 0),
    passed: attempts.filter((a) => a.passed).length,
    attempts: attempts.length,
    timeouts: attempts.filter((a) => a.timedOut).length,
    injected: attempts.filter((a) => a.followedInjection !== undefined).length,
    followedInjection: attempts.filter((a) => a.followedInjection).length,
    steps: mean(attempts.map((a) => a.steps)),
    toolCalls: mean(attempts.map((a) => Object.values(a.toolCalls).reduce((sum, n) => sum + n, 0))),
    toolErrors: mean(attempts.map((a) => a.toolErrors)),
    toolErrorsByTool: totals(attempts.map((a) => a.toolErrorsByTool ?? {})),
    tokensIn: mean(attempts.map((a) => a.tokensIn)),
    tokensOut: mean(attempts.map((a) => a.tokensOut)),
    cost: mean(attempts.map((a) => a.cost)),
    seconds: mean(attempts.map((a) => a.seconds)),
  };
}

function totals(counts: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const count of counts) for (const [key, n] of Object.entries(count)) total[key] = (total[key] ?? 0) + n;
  return total;
}

function mean(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

/** Formats a table with aligned columns, as plain text or Markdown. */
export function formatTable(rows: string[][], markdown = false): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  const line = (row: string[]) => row.map((cell, col) => cell.padEnd(widths[col])).join(markdown ? " | " : "  ");
  if (!markdown) return rows.map(line).join("\n");
  const [head, ...body] = rows.map((row) => `| ${line(row)} |`);
  return [head, `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...body].join("\n");
}

export const money = (v: number | null) => (v === null ? "-" : `$${v.toFixed(4)}`);
export const num = (v: number | null, digits = 1) => (v === null ? "-" : v.toFixed(digits));
export const percent = (v: number) => `${Math.round(v * 100)}%`;
