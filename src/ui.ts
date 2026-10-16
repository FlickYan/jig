// The terminal: the model's reply and thinking as they stream, each tool call with a few lines of its
// result, notices, a status line while waiting, and the prompt for the user's input. Everything jig prints
// goes through here, so lines and blocks don't run into each other.

import * as readline from "node:readline";
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

/** What the user entered, and whether they pressed Ctrl+C instead of Enter. Null: Ctrl+D, or the input ended. */
type Entry = { text: string; interrupted: boolean } | null;

const MORE = dim("… "); // the prompt for a line that goes with the one above it

/**
 * The user's input, read by one readline interface for the whole session, so piped input isn't lost between
 * prompts (an interface for each prompt read the whole pipe and kept only its first line) and the history
 * carries over. At a terminal it takes the terminal over only while asking: between prompts it is paused and
 * out of raw mode, so Ctrl+C during a task is the signal that stops it.
 */
export class Input {
  private input: NodeJS.ReadStream;
  private output: NodeJS.WriteStream;
  private terminal: boolean; // readline edits the line: arrow keys, Up for the history
  private rl: readline.Interface | undefined;
  private history: string[] = []; // the tasks and commands entered, newest first, kept for the next interface too
  private redraws: ((...args: unknown[]) => void)[] = [];
  private answer: ((entry: Entry) => void) | undefined; // the read waiting for an entry
  private keep = false; // whether that entry joins the history
  private queued: string[] = []; // piped entries not asked for yet
  private ended = false; // the piped input has ended
  private closed = false; // the interface has closed: Ctrl+C or Ctrl+D, or the input ended
  private pasting = false;
  private pasted: string[] = []; // lines that go with the next one: a paste's, or ending in \

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    this.input = input;
    this.output = output;
    this.terminal = !!input.isTTY && !!output.isTTY;
  }

  /** The next entry. Only tasks and commands (`keep`) join the history, not the answers to questions. */
  read(prompt: string, keep: boolean): Promise<Entry> {
    return new Promise((resolve) => {
      if (this.ended && !this.queued.length) return resolve(null);
      const rl = this.open();
      this.keep = keep;
      this.answer = (entry) => {
        this.answer = undefined;
        this.listen(rl, false);
        resolve(entry);
      };
      if (!this.terminal) {
        this.output.write(prompt);
        if (this.queued.length) this.answer({ text: this.queued.shift()!, interrupted: false });
        else this.listen(rl, true);
        return;
      }
      rl.setPrompt(prompt);
      this.listen(rl, true);
      rl.prompt();
    });
  }

  private open(): readline.Interface {
    if (this.rl) return this.rl;
    const resizes = this.output.listeners("resize");
    // A copy: readline adds to the array it is given, and only some lines stay (see "history" below).
    const rl = readline.createInterface({ input: this.input, output: this.output, terminal: this.terminal, history: [...this.history] });
    this.rl = rl;
    this.closed = false;
    // readline redraws its line when the terminal is resized, paused or not, which would write over what a
    // task printed since: it hears of resizes only while asking (see listen).
    this.redraws = this.output.listeners("resize").filter((listener) => !resizes.includes(listener)) as ((...args: unknown[]) => void)[];
    rl.on("line", (line) => {
      // At a terminal, only what is typed while jig asks counts: a line that came in with the one before it
      // (pasted where the terminal doesn't mark pastes) mustn't answer the next question.
      if (this.input.isTTY && !this.answer) return;
      if (this.pasting || line.endsWith("\\")) {
        this.pasted.push(this.pasting ? line : line.slice(0, -1));
        if (this.terminal) {
          rl.setPrompt(MORE);
          rl.prompt();
        }
        return;
      }
      const text = [...this.pasted.splice(0), line].join("\n");
      if (this.answer) this.answer({ text, interrupted: false });
      else this.queued.push(text);
    });
    rl.on("history", (history: string[]) => {
      // readline adds every line it reads. Only a task or command of one line stays, so Up brings back those,
      // not a "y" or a line of a paste.
      if (this.keep && !this.pasting && !this.pasted.length && !rl.line.endsWith("\\")) this.history = [...history];
      else history.splice(0, history.length, ...this.history);
    });
    rl.on("SIGINT", () => {
      const text = [...this.pasted.splice(0), rl.line].join("\n");
      rl.write(null, { ctrl: true, name: "e" }); // past what was typed, which stays on the screen
      this.output.write("\n");
      this.answer?.({ text, interrupted: true });
      rl.close(); // readline can't empty its line without erasing it: the next read opens a new interface
    });
    rl.on("close", () => {
      this.closed = true;
      if (this.terminal) this.rl = undefined; // Ctrl+C or Ctrl+D; the history goes on in the next one
      else this.ended = true;
      this.pasting = false;
      this.pasted = [];
      if (this.answer) this.output.write("\n"); // Ctrl+D, or the input ended, after the prompt
      this.answer?.(null);
    });
    if (this.terminal) {
      // The terminal marks a paste (see listen), and its lines go with the line after it, so a task and the
      // error log pasted under it are one message, sent with Enter.
      const onKey = (_: unknown, key?: readline.Key) => {
        if (key?.name === "paste-start" || key?.name === "paste-end") this.pasting = key.name === "paste-start";
      };
      this.input.on("keypress", onKey);
      rl.once("close", () => this.input.off("keypress", onKey));
    }
    return rl;
  }

  /** Reads the input, and at a terminal takes it over (raw mode, marked pastes, resizes), only while asking. */
  private listen(rl: readline.Interface, on: boolean): void {
    // Once closed (Ctrl+D, or the input ended) it stays paused, and Node 24 throws at pause() and resume().
    // The terminal still has to be given back.
    if (!this.closed) {
      if (on) rl.resume();
      else rl.pause();
    }
    if (!this.terminal) return;
    this.input.setRawMode(on);
    this.output.write(on ? "\x1b[?2004h" : "\x1b[?2004l"); // bracketed paste on or off
    for (const redraw of this.redraws) {
      this.output.off("resize", redraw);
      if (on) this.output.on("resize", redraw);
    }
  }
}

let stdin: Input | undefined;
const userInput = () => (stdin ??= new Input(process.stdin, process.stdout));

async function read(prompt: string, keep: boolean, from: Input): Promise<Entry> {
  freshLine();
  clearStatus();
  const entry = await from.read(prompt, keep);
  atLineStart = true; // after Enter, or the new line Input starts at Ctrl+C or Ctrl+D
  return entry;
}

/** Reads one line from the user (or a paste and the line after it). Returns null on Ctrl+C or Ctrl+D. */
export async function ask(prompt: string, from = userInput()): Promise<string | null> {
  const entry = await read(prompt, false, from);
  return entry && !entry.interrupted ? entry.text : null;
}

/**
 * Reads the next task or command at the session's prompt. Ctrl+C drops what was typed; at an empty prompt it
 * says how to quit, and pressed again there it quits, as Ctrl+D does: null.
 */
export async function askTask(prompt: string, from = userInput()): Promise<string | null> {
  for (let warned = false; ; ) {
    const entry = await read(prompt, true, from);
    if (entry && !entry.interrupted) return entry.text;
    const empty = !entry?.text.trim();
    if (!entry || (warned && empty)) return null;
    warned = empty;
    if (warned) println(dim("To quit, press Ctrl+C again, or Ctrl+D, or type /exit."));
  }
}
