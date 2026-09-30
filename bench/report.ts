#!/usr/bin/env node
// Compares saved benchmark runs, as Markdown you can paste into a README.
// Usage: node bench/report.ts [results/*.json ...]   (default: every run in bench/results)
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Attempt, formatTable, money, num, percent, type Summary } from "./metrics.ts";

interface Run {
  id: string;
  label: string;
  version: string;
  model: string;
  settings: { attempts: number };
  summary: Summary;
  attempts: Attempt[];
}

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "results");

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  const paths = files.length
    ? files
    : existsSync(RESULTS)
      ? (await readdir(RESULTS)).filter((f) => f.endsWith(".json")).sort().map((f) => join(RESULTS, f))
      : [];
  if (paths.length === 0) {
    console.log("No results yet. Run the benchmark first: npm run bench");
    return;
  }
  const runs: Run[] = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));

  console.log("## Runs\n");
  console.log(
    formatTable(
      [
        ["run", "jig version", "model", "passed", "steps", "tool calls", "tool errors", "tokens in", "tokens out", "cost", "time"],
        ...runs.map(({ label, version, model, summary: s }) => [
          label,
          version,
          model,
          `${percent(s.passRate)}${s.passRateSpread ? ` ±${percent(s.passRateSpread)}` : ""} (${s.passed}/${s.attempts})`,
          num(s.steps),
          num(s.toolCalls),
          num(s.toolErrors),
          num(s.tokensIn, 0),
          num(s.tokensOut, 0),
          money(s.cost),
          `${num(s.seconds, 0)}s`,
        ]),
      ],
      true,
    ),
  );
  console.log("\nSteps, tool calls, tool errors, tokens, cost and time are averages per attempt.\n");

  console.log("## Tasks solved\n");
  const tasks = [...new Set(runs.flatMap((run) => run.attempts.map((a) => a.task)))].sort();
  const cell = (run: Run, task: string) => {
    const mine = run.attempts.filter((a) => a.task === task);
    return mine.length ? `${mine.filter((a) => a.passed).length}/${mine.length}` : "-";
  };
  console.log(formatTable([["task", ...runs.map((run) => run.label)], ...tasks.map((task) => [task, ...runs.map((run) => cell(run, task))])], true));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
