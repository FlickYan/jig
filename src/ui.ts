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

export function notice(text: string): void {
  println(yellow(text));
}

export function error(text: string): void {
  println(red(text));
}

// Streaming model output. Text is the reply itself; progress notes are the short updates the model
// writes between tool calls, shown dimmed.

export function text(delta: string): void {
  startBlockOutput(delta);
  write(delta);
}

export function progress(delta: string): void {
  startBlockOutput(delta);
  write(dim(delta));
}

export function endBlock(): void {
  if (blockHasOutput) freshLine();
  blockHasOutput = false;
}

function startBlockOutput(delta: string): void {
  if (delta && !blockHasOutput) {
    freshLine();
    blockHasOutput = true;
  }
}

export const terminalUI: AgentUI = {
  toolCall(name, description) {
    const [summary = "", ...details] = description.split("\n");
    println(`${cyan("●")} ${bold(name)} ${clip(summary)}`);
    for (const line of details.slice(0, MAX_DETAIL_LINES)) {
      println(`  ${line.startsWith("- ") ? red(clip(line)) : line.startsWith("+ ") ? green(clip(line)) : clip(line)}`);
    }
    if (details.length > MAX_DETAIL_LINES) println(dim(`  … ${moreLines(details.length - MAX_DETAIL_LINES)}`));
  },

  toolResult(output, isError) {
    const lines = output.split("\n").filter((line) => line.trim() !== "");
    const shown = lines.slice(0, PREVIEW_LINES);
    shown.forEach((line, i) => println(isError ? red(`  ${i === 0 ? "✗ " : "  "}${clip(line)}`) : dim(`  ${clip(line)}`)));
    if (lines.length > shown.length) println(dim(`  … ${moreLines(lines.length - shown.length)}`));
  },
};

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
