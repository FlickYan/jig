// The benchmark's passed attempts as fine-tuning data: for each attempt whose hidden tests passed, its
// session, in OpenAI's chat fine-tuning format (see src/export.ts). The tests are ones the model never
// saw, so these are its own successes, checked by something other than the model: the examples a model
// is trained on to improve on itself (rejection-sampling fine-tuning, or STaR). Nothing here trains one.
//
//   node bench/export.ts <results file>... [--out examples.jsonl]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exampleProblems, exportSession } from "../src/export.ts";

const LOGS = join(dirname(fileURLToPath(import.meta.url)), "logs");

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string", short: "o" } } });
if (!positionals.length) {
  console.log("Usage: node bench/export.ts <results file>... [--out examples.jsonl]");
  process.exit(1);
}

const lines: string[] = [];
let passed = 0;
let unrecorded = 0;
let invalid = 0;
let redacted = 0;
for (const file of positionals) {
  const run = JSON.parse(readFileSync(file, "utf8")) as { id: string; attempts: { task: string; passed: boolean; session?: string }[] };
  for (const attempt of run.attempts.filter((a) => a.passed)) {
    passed++;
    // Recorded since milestone 14: earlier runs kept their sessions, but not which attempt each was.
    const exported = attempt.session ? exportSession(join(LOGS, run.id, attempt.session)) : undefined;
    if (!exported) {
      unrecorded++;
      continue;
    }
    if (exampleProblems(exported.example).length) {
      invalid++;
      continue;
    }
    lines.push(JSON.stringify(exported.example));
    redacted += exported.redacted;
  }
}
const text = lines.length ? `${lines.join("\n")}\n` : "";
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
const notes = [unrecorded && `${unrecorded} without a recorded session`, invalid && `${invalid} left out, their messages in an order a trainer would reject`, redacted && `${redacted} secrets blanked out`].filter(Boolean);
console.error(`${lines.length} examples from ${passed} passed attempts in ${positionals.length} ${positionals.length === 1 ? "run" : "runs"}${notes.length ? ` (${notes.join("; ")})` : ""}.`);
