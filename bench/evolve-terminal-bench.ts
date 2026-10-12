// The last check on a candidate the referee accepted: Terminal-Bench itself, against jig as it was where
// the candidate branched. The evolve suite is a proxy, and the first change it accepted solved 15 points
// fewer Terminal-Bench tasks (milestone 17); a cheaper stand-in for Terminal-Bench didn't agree with it
// (milestone 18). So `npm run evolve -- tbcheck <n>` runs both on Terminal-Bench, and these are the
// parts of it that don't need Docker or the API: the verdict, and when a run may start.

import { type Attempt, compare, type Comparison } from "./evolve-referee.ts";

/** One trial as eval/report.py --save keeps it. */
export interface Trial {
  task: string;
  passed: boolean;
  /** The agent fetched the benchmark's own files: the trial counts as failed, whatever it scored. */
  looked_up?: boolean;
  input?: number;
  cached?: number;
  output?: number;
}

/** Prices of deepseek-flash per token, as eval/report.py has them: uncached input, cached input, output. */
const PRICE = { input: 0.3e-6, cached: 0.006e-6, output: 1.2e-6 };

/** Trials as the referee compares attempts: a look-up is a failure, and the cost comes from the tokens. */
export function attemptsOf(trials: Trial[]): Attempt[] {
  return trials.map((trial) => {
    const cached = trial.cached ?? 0;
    const cost = trial.input === undefined ? null : (trial.input - cached) * PRICE.input + cached * PRICE.cached + (trial.output ?? 0) * PRICE.output;
    return { task: trial.task, passed: trial.passed && !trial.looked_up, cost };
  });
}

export interface TerminalBenchVerdict {
  /** The candidate against the baseline, paired by task, as the referee compares. */
  comparison: Comparison;
  /** The share of resamples in which the candidate solved fewer tasks. */
  behind: number;
  rejected: boolean;
  reason: string;
}

/**
 * The referee's bar turned around: on the training and held-out tasks a candidate has to be ahead in 80%
 * of resamples to pass; here it fails if it is behind in 80% of them. Terminal-Bench guards against harm,
 * and with two attempts at twenty tasks it can't confirm a gain, only a loss.
 */
export function terminalBenchVerdict(candidate: Attempt[], baseline: Attempt[]): TerminalBenchVerdict {
  const comparison = compare(candidate, baseline);
  const behind = compare(baseline, candidate).ahead;
  const points = `${comparison.difference > 0 ? "+" : ""}${Math.round(comparison.difference * 100)} points`;
  const rate = (value: number) => `${Math.round(value * 100)}%`;
  const scores = `${rate(comparison.candidate)} against ${rate(comparison.baseline)}, ${points}`;
  return behind >= 0.8
    ? { comparison, behind, rejected: true, reason: `solved fewer Terminal-Bench tasks (${scores}, behind in ${rate(behind)} of resamples)` }
    : { comparison, behind, rejected: false, reason: `no worse on Terminal-Bench (${scores}, behind in ${rate(behind)} of resamples)` };
}

/** DeepSeek's expensive hours, which the user asked runs to stay out of: weekdays 9 to 12 and 14 to 18. */
export const PEAK_HOURS: [number, number][] = [
  [9, 12],
  [14, 18],
];

/**
 * The earliest time, from `now`, at which a run of `hours` hours can start and finish without touching the
 * peak hours (local time, Monday to Friday). Weekends and nights are free.
 */
export function nextStart(now: Date, hours: number): Date {
  let start = new Date(now);
  for (;;) {
    const end = new Date(start.getTime() + hours * 3_600_000);
    const clash = peaksBetween(start, end).find(([from, to]) => start < to && end > from);
    if (!clash) return start;
    start = clash[1];
  }
}

/** The peak windows of every day from the day of `from` to the day of `to`. */
function peaksBetween(from: Date, to: Date): [Date, Date][] {
  const windows: [Date, Date][] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (; day <= to; day.setDate(day.getDate() + 1)) {
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    for (const [a, b] of PEAK_HOURS) {
      windows.push([new Date(day.getFullYear(), day.getMonth(), day.getDate(), a), new Date(day.getFullYear(), day.getMonth(), day.getDate(), b)]);
    }
  }
  return windows;
}

/** The order of the runs, alternating so that whatever the service does over the hours falls on both. */
export function runOrder(rounds: number): { side: "baseline" | "candidate"; round: number }[] {
  const order: { side: "baseline" | "candidate"; round: number }[] = [];
  for (let round = 1; round <= rounds; round++) {
    const pair = round % 2 ? (["baseline", "candidate"] as const) : (["candidate", "baseline"] as const);
    for (const side of pair) order.push({ side, round });
  }
  return order;
}
