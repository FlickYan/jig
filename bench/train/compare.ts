#!/usr/bin/env node
// Milestone 27: jig driving the base model against the fine-tuned one, on the held-out tasks of every suite,
// paired by task, as the referee compares (bench/evolve-referee.ts), and how each one worked: steps, failed
// tool calls, how often it stopped of its own accord on a task it hadn't solved, and, from the runs' logs
// (bench/logs, kept on the machine that ran them), how often it repeated a call and outgrew the server.
//
//   node bench/train/compare.ts [base label] [tuned label]       (default m27-qwen-base, m27-jig)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compare } from "../evolve-referee.ts";
import { formatTable, type Attempt } from "../metrics.ts";

const RESULTS = join(import.meta.dirname, "..", "results");
const LOGS = join(import.meta.dirname, "..", "logs");
const [base = "m27-qwen-base", tuned = "m27-jig"] = process.argv.slice(2);

type Seen = Attempt & { suite: string; repeated?: number; outgrew?: boolean; calls?: number };

/** A label's attempts in every suite, each task named with its suite so tasks from different suites stay apart. */
function attempts(label: string): Seen[] {
  const found: Seen[] = [];
  for (const suite of ["", "evolve", "evolve2", "explore"]) {
    const dir = join(RESULTS, suite);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(`_${label}.json`))) {
      const run = JSON.parse(readFileSync(join(dir, file), "utf8"));
      found.push(...run.attempts.map((a: Attempt) => ({ ...a, ...fromLogs(join(LOGS, run.id), a), suite: suite || "tasks", task: `${suite || "tasks"}/${a.task}` })));
    }
  }
  return found;
}

/**
 * From an attempt's log and session: the longest run of the same tool call (name and input) made again and
 * again, the model calls made, and whether it ended because the conversation outgrew the server's context.
 */
function fromLogs(dir: string, a: Attempt & { session?: string }): { repeated?: number; outgrew?: boolean; calls?: number } {
  const log = join(dir, `${a.task}-${a.attempt}.log`);
  if (!a.session || !existsSync(join(dir, a.session)) || !existsSync(log)) return {};
  const replies = readFileSync(join(dir, a.session), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).message)
    .filter((m) => m?.role === "assistant");
  let repeated = 0;
  let run = 0;
  let last = "";
  for (const block of replies.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_use")) {
    const call = JSON.stringify([block.name, block.input]);
    run = call === last ? run + 1 : 1;
    last = call;
    repeated = Math.max(repeated, run);
  }
  return { repeated, outgrew: readFileSync(log, "utf8").includes("maximum context length"), calls: replies.length };
}

const sides = { [base]: attempts(base), [tuned]: attempts(tuned) };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const rows = [["", "passed", "steps", "failed tool calls", "stopped unsolved before the limit", "made a call 5+ times in a row", "outgrew the server", "tokens written a call", ...["tasks", "evolve", "evolve2", "explore"]]];
for (const [label, list] of Object.entries(sides)) {
  const n = list.length;
  const mean = (f: (a: Seen) => number) => (list.reduce((s, a) => s + f(a), 0) / n).toFixed(1);
  const logged = list.filter((a) => a.calls !== undefined);
  // Tokens are counted only for attempts that ended with jig's stats, not on an error.
  const counted = logged.filter((a) => a.tokensOut != null);
  const written = counted.reduce((s, a) => s + a.tokensOut!, 0) / counted.reduce((s, a) => s + a.calls!, 0);
  // An attempt that ended on an error (the server's limit, say) has no step count: it didn't stop of its own accord.
  const early = list.filter((a) => !a.passed && !a.timedOut && a.steps != null && a.steps < 40).length;
  const bySuite = ["tasks", "evolve", "evolve2", "explore"].map((suite) => {
    const s = list.filter((a) => a.suite === suite);
    return `${s.filter((a) => a.passed).length}/${s.length}`;
  });
  rows.push([
    label,
    `${list.filter((a) => a.passed).length}/${n} (${pct(list.filter((a) => a.passed).length / n)})`,
    mean((a) => a.steps ?? a.calls ?? 0),
    mean((a) => a.toolErrors),
    `${early} of ${list.filter((a) => !a.passed).length}`,
    `${logged.filter((a) => a.repeated! >= 5).length} of ${logged.length}`,
    `${logged.filter((a) => a.outgrew).length} of ${logged.length}`,
    counted.length ? String(Math.round(written)) : "-",
    ...bySuite,
  ]);
}
console.log(formatTable(rows, true));
const c = compare(sides[tuned], sides[base]);
console.log(`\n${tuned} against ${base}, paired by task (${c.tasks} tasks): ${pct(c.candidate)} against ${pct(c.baseline)}, ${c.difference >= 0 ? "+" : ""}${Math.round(c.difference * 100)} points (${Math.round(c.low * 100)} to ${Math.round(c.high * 100)}), ahead in ${pct(c.ahead)} of resamples`);
const tasks = [...new Set(sides[base].map((a) => a.task))].sort();
const changed = tasks
  .map((task) => [task, ...[base, tuned].map((l) => sides[l].filter((a) => a.task === task && a.passed).length)] as const)
  .filter(([, b, t]) => b !== t);
console.log(`tasks that changed: ${changed.map(([task, b, t]) => `${task} ${b}→${t}`).join(", ") || "none"}`);
const injected = Object.entries(sides).map(([l, list]) => `${l}: ${list.filter((a) => a.followedInjection).length} of ${list.filter((a) => a.followedInjection !== undefined).length}`);
console.log(`attempts that followed an injected instruction: ${injected.join("; ")}`);
