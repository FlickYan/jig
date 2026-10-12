// Reading benchmark attempts for `bench/evolve.ts`: what a failed attempt shows (the tests that failed,
// and what the agent said it had done), where an attempt's steps went, and the words that would tie a
// change to the tasks.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface AttemptLog {
  /** The agent's last words before the summary line: usually its claim of what it did. */
  finalMessage: string;
  /** The hidden tests that failed, with their assertion messages. */
  failures: string[];
  /** The agent's tool calls in order, one line each: where its steps went. */
  toolCalls: string[];
}

/** Splits an attempt's log (see bench/run.ts): the transcript, then "--- changes ---", then "--- check ---". */
export function readAttemptLog(text: string): AttemptLog {
  const [transcript = "", rest = ""] = text.split(/^--- changes ---$/m);
  const check = rest.split(/^--- check ---$/m)[1] ?? "";
  const beforeSummary = transcript.split(/^\d+ steps? · .*$/m)[0] ?? transcript;
  const finalMessage = beforeSummary.trim().split("\n").slice(-15).join("\n").slice(-1500);
  const failures = check
    .split("\n")
    .filter((line) => /^(FAIL|ERROR): /.test(line) || /^\w*(Error|Exception)\b/.test(line))
    .map((line) => line.trim().slice(0, 300))
    .slice(0, 12);
  const toolCalls = [...transcript.matchAll(/^● (.*)$/gm)].map((match) => match[1].slice(0, 160));
  return { finalMessage, failures, toolCalls };
}

/** The line after "Summary:" in an agent's reply, and the paragraph after it (else its last paragraph). */
export function replySummary(transcript: string): { subject: string; description: string } {
  const text = readAttemptLog(transcript).finalMessage;
  // The last such line: thinking printed before the reply can draft one (milestone 20's fifth candidate
  // counted the words of its summary there, and that became its subject).
  const line = [...text.matchAll(/^\W*Summary\W*\s*(.+)$/gim)].at(-1);
  const rest = line ? text.slice(line.index! + line[0].length) : text;
  const paragraphs = rest.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const description = (line ? paragraphs[0] : paragraphs.at(-1)) ?? "";
  const subject = line?.[1] ?? description.split(/(?<=\.)\s/)[0];
  return { subject: subject.replace(/[*`]/g, "").trim().slice(0, 72), description };
}

/** The names of the failed tests in `node --test` output (the spec reporter's closing list). */
export function failingTests(output: string): string[] {
  const list = output.split(/^✖ failing tests:$/m)[1] ?? "";
  return [...new Set([...list.matchAll(/^\s*✖ (.+?) \([\d.]+m?s\)$/gm)].map((match) => match[1]))];
}

/**
 * Words that would tie a change to these tasks: the task ids, the names of their projects' files (SPEC.md,
 * money.py), the functions they define with an underscore in the name (parse_duration, not render), and
 * the flags and environment variables their instructions name. Generic words stay out, so a change can
 * still talk about specs or tests.
 */
export function taskWords(tasksDir: string): string[] {
  const words = new Set<string>();
  for (const id of readdirSync(tasksDir).filter((name) => existsSync(join(tasksDir, name, "task.json")))) {
    words.add(id);
    const instruction = JSON.parse(readFileSync(join(tasksDir, id, "task.json"), "utf8")).instruction as string;
    for (const match of instruction.matchAll(/--[a-z][a-z-]+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) words.add(match[0]);
    for (const file of projectFiles(join(tasksDir, id, "repo"))) {
      const name = basename(file);
      if (!name.startsWith(".") && name !== "__init__.py") words.add(name);
      if (!name.endsWith(".py")) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/^\s*def ([a-z]\w*_\w+)\(/gm)) words.add(match[1]);
    }
  }
  return [...words].sort();
}

function projectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes("__pycache__"))
    .map((entry) => join(entry.parentPath, entry.name));
}
