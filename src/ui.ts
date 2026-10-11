// The terminal: the model's reply and thinking as they stream, each tool call with a few lines of its
// result, notices, a status line while waiting, and the prompt for the user's input. Everything jig prints
// goes through here, so lines and blocks don't run into each other.

import * as readline from "node:readline/promises";
import { styleText } from "node:util";
import type { AgentUI } from "./agent.ts";

// styleText drops the colors when stdout is not a terminal or NO_COLOR is set.
const style = (format: Parameters<typeof styleText>[0]) => (text: string) => styleText(format, text);
export const bold = style("bold");
export const dim = style("dim");
export const red = style("red");
export const green = style("green");
export const yellow = style("yellow");
export const cyan = style("cyan");

const PREVIEW_LINES = 3; // lines of each tool result shown in the terminal
const MAX_DETAIL_LINES = 40; // lines of a diff or long command shown before a tool call
const MAX_LINE_CHARS = 160;

let atLineStart = true; // so every block starts on a fresh line
let statusShown = false; // a transient "⋯ thinking…" line that the next output replaces
let blockHasOutput = false;

function write(text: string): void {
  if (!text) return;
  clearStatus();
  process.stdout.write(text);
  atLineStart = text.endsWith("\n");
}

function clearStatus(): void {
  if (!statusShown) return;
  process.stdout.write("\r\x1b[2K"); // back to column 0, erase the line
  statusShown = false;
}

function freshLine(): void {
  if (!atLineStart) write("\n");
}

/** Prints a line, starting a new one first if the cursor isn't at the start of one. */
export function println(text = ""): void {
  freshLine();
  write(`${text}\n`);
}

/** Shows what we are waiting for until the next output replaces it. Only on a terminal. */
export function status(text: string): void {
  if (!process.stdout.isTTY) return;
  freshLine();
  clearStatus();
  process.stdout.write(dim(`⋯ ${text}`));
  statusShown = true;
}

/** Something the user should know, in yellow: a retry, a compaction, a warning. */
export function notice(text: string): void {
  println(yellow(text));
}

export function error(text: string): void {
  println(red(text));
}

// Streaming model output. Text is the reply itself. Thinking is shown dimmed: for Claude that is short
// progress notes between tool calls, for DeepSeek its whole reasoning, which can be long, so it can be hidden.

let showThinking = true;
let thinkingStarted = 0; // when the hidden thinking block began, for the status line
let thinkingShownAt = 0;

/** Shows or hides the model's thinking (--hide-thinking, /thinking). */
export function setThinkingVisible(visible: boolean): void {
  showThinking = visible;
}

export function thinkingVisible(): boolean {
  return showThinking;
}

/** A piece of the model's reply, as it streams. */
export function text(delta: string): void {
  startBlockOutput(delta);
  write(delta);
}

/** A piece of the model's thinking: dimmed, or, when hidden, a status line counting the seconds. */
export function thinking(delta: string): void {
  if (!delta) return;
  if (showThinking) {
    startBlockOutput(delta);
    write(dim(delta));
    return;
  }
  // Hidden: keep a ticking status line instead, so a long think doesn't look like a hang.
  const now = Date.now();
  thinkingStarted ||= now;
  if (now - thinkingShownAt >= 1000) {
    status(`thinking… ${Math.round((now - thinkingStarted) / 1000)}s`);
    thinkingShownAt = now;
  }
}

/** A content block of the reply has ended: the next one starts on a line of its own. */
export function endBlock(): void {
  if (blockHasOutput) freshLine();
  blockHasOutput = false;
  thinkingStarted = 0;
}

function startBlockOutput(delta: string): void {
  if (delta && !blockHasOutput) {
    freshLine();
    blockHasOutput = true;
  }
}

// Calls that only read run at the same time, so a result doesn't always come right after its call's
// line. Such a result gets a line saying whose it is.
const callLabels = new Map<string, string>();
let lastCall: string | undefined; // the call the last tool line was about

/** The main agent's tool calls: a line per call, the diff or command below it, and a preview of the result. */
export const terminalUI: AgentUI = {
  toolCall(name, description, id) {
    const [summary = "", ...details] = description.split("\n");
    println(`${cyan("●")} ${bold(name)} ${clip(summary)}`);
    callLabels.set(id, `${name} ${clip(summary)}`);
    lastCall = id;
    for (const line of details.slice(0, MAX_DETAIL_LINES)) {
      println(`  ${line.startsWith("- ") ? red(clip(line)) : line.startsWith("+ ") ? green(clip(line)) : clip(line)}`);
    }
    if (details.length > MAX_DETAIL_LINES) println(dim(`  … ${moreLines(details.length - MAX_DETAIL_LINES)}`));
  },

  toolResult(output, isError, id) {
    if (id !== lastCall) println(dim(`  ⎿ ${callLabels.get(id) ?? ""}`));
    callLabels.delete(id);
    lastCall = id;
    const lines = output.split("\n").filter((line) => line.trim() !== "");
    const shown = lines.slice(0, PREVIEW_LINES);
    shown.forEach((line, i) => println(isError ? red(`  ${i === 0 ? "✗ " : "  "}${clip(line)}`) : dim(`  ${clip(line)}`)));
    if (lines.length > shown.length) println(dim(`  … ${moreLines(lines.length - shown.length)}`));
  },

  notice: (text) => println(yellow(text)),
};

/**
 * A subagent's tool calls, indented under its own call and labelled with its task, since several can
 * run at once. Results are left out (the subagent's answer sums them up), apart from failures.
 */
export function subagentUI(label: string): AgentUI {
  const prefix = dim(`  │ ${label.length > 40 ? `${label.slice(0, 40)}…` : label} ·`);
  return {
    toolCall(name, description) {
      println(`${prefix} ${name} ${dim(clip(description.split("\n")[0]))}`);
      lastCall = undefined; // the subagent's own result, when it comes, needs saying whose it is
    },
    toolResult(output, isError) {
      if (isError) println(`${prefix} ${red(clip(output.split("\n")[0]))}`);
    },
    notice: (text) => println(`${prefix} ${yellow(text)}`),
  };
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

function moreLines(n: number): string {
  return `${n} more line${n === 1 ? "" : "s"}`;
}

/** The terminal echoed ^C where the cursor was, so the next output needs a line of its own. */
export function interrupted(): void {
  atLineStart = false;
}

/** Reads one line from the user. Returns null on Ctrl+C or Ctrl+D. */
export async function ask(prompt: string): Promise<string | null> {
  freshLine();
  clearStatus();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController();
  rl.on("SIGINT", () => cancel.abort()); // Ctrl+C while typing
  rl.on("close", () => cancel.abort()); // Ctrl+D, or stdin ended
  try {
    const answer = await rl.question(prompt, { signal: cancel.signal });
    atLineStart = true; // the user pressed Enter
    return answer;
  } catch {
    atLineStart = false; // the cursor is still after the prompt
    return null;
  } finally {
    rl.close();
  }
}
