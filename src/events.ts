// --events: a one-shot task as JSON lines, for a backend that runs jig as a task and follows it there
// rather than in the terminal's output. One object a line, each written as it happens, with what the
// terminal shows (the steps, the tool calls and their results, the notices) and how the task ended.
// The fields are a contract (version 1): a reader ignores a type it doesn't know, and a field may be added.
// A library's task (lib.ts) gets the same objects, handed to its listener instead of written.

import { closeSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { addUsage, type AgentUI, type Usage } from "./agent.ts";
import { redact } from "./export.ts";
import type { CallModel } from "./model.ts";
import { costOf } from "./prices.ts";
import { truncate } from "./tools/index.ts";

/** The most of a tool's output an event holds: the terminal shows a few lines, a backend wants more. */
export const EVENT_OUTPUT_CHARS = 4_000;
// What truncate's line saying how much it cut takes, at most, so the output with it stays under the limit.
const CUT_LINE = 64;

/** One event, as a line of --events holds it. */
export type Event = { v: 1; seq: number; ts: string; type: string } & Record<string, unknown>;

/** How the task ended, as its end event says. */
export interface End {
  stop: string;
  exitCode: number;
  steps: number;
  usage: Usage;
  cost: number | null;
  seconds: number;
}

/** What the start of a task says about it. */
export interface Start {
  task: string;
  cwd: string;
  model: string;
  version: string;
  limits: { maxSteps: number; timeLimit: number | null };
}

/**
 * The events of one run, written to `path`, or to stdout for "-", or handed to a listener as objects. The
 * file is opened before the task starts and written anew: made beside the path and renamed into place, so a
 * link a command left there (one an earlier run's background job made, say) is replaced, not written
 * through, as --stats' file is. A path in /dev or /proc is written to as it is. Each event is one write to
 * that file, so a crash loses at most the line being written. Every string goes through the redaction
 * `jig sessions export` uses.
 */
export class Events {
  private readonly fd: number | undefined; // undefined: stdout, or the listener
  private readonly listener: ((event: Event) => void) | undefined;
  private readonly model: string;
  private readonly started = Date.now();
  private seq = 0;
  private step = 0; // the loop's step, for the tool calls and text that come in it
  private readonly usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  private cost: number | null;
  private ended = false;

  constructor(path: string | ((event: Event) => void), model: string) {
    this.model = model;
    this.cost = costOf(model, this.usage) ?? null;
    if (typeof path === "function") this.listener = path;
    if (typeof path === "function" || path === "-") return;
    if (/^\/(dev|proc)\//.test(path)) {
      this.fd = openSync(path, "a");
      return;
    }
    const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    this.fd = openSync(temp, "wx"); // never through a file already there
    try {
      renameSync(temp, path);
    } catch (error) {
      closeSync(this.fd);
      rmSync(temp, { force: true });
      throw error;
    }
  }

  start(start: Start): void {
    this.write("start", { ...start });
  }

  /** The terminal's UI, with each step, tool call and result written as an event too. */
  ui(base: AgentUI): AgentUI {
    return {
      ...base,
      step: (step, reply) => {
        base.step?.(step, reply);
        this.step = step;
        const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
        addUsage(usage, reply.usage);
        this.write("step", { step, usage: inOrder(usage), cost: costOf(reply.model ?? this.model, usage) ?? null });
        if (reply.text.trim()) this.text(reply.text);
      },
      toolCall: (name, description, id) => {
        base.toolCall(name, description, id);
        this.write("tool_call", { step: this.step, id, name, description });
      },
      toolResult: (output, isError, id) => {
        base.toolResult(output, isError, id);
        // Redacted before the cut, so that a key cut in two isn't left half there.
        const whole = redact(output).value;
        const shown = whole.length > EVENT_OUTPUT_CHARS ? truncate(whole, EVENT_OUTPUT_CHARS - CUT_LINE) : whole;
        this.write("tool_result", { step: this.step, id, isError, output: shown, ...(shown !== whole && { truncated: true }) });
      },
    };
  }

  /** The same model, its usage and cost added to the end's: `model` is whose calls they are. */
  meter(callModel: CallModel, model: string): CallModel {
    return async (messages, signal, options) => {
      const turn = await callModel(messages, signal, options);
      const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      addUsage(usage, turn.message.usage);
      addUsage(this.usage, turn.message.usage);
      const cost = costOf(model, usage);
      // One call of a model without a price leaves the whole without one.
      this.cost = this.cost === null || cost === undefined ? null : this.cost + cost;
      return turn;
    };
  }

  /** The model's text in the current step (or the wrap-up's after the last). */
  text(text: string): void {
    this.write("text", { step: this.step, text });
  }

  notice(text: string): void {
    this.write("notice", { text });
  }

  /** How the task ended, and the code jig exits with. Only the first end is written, and returned. */
  end(stop: string, exitCode: number): End | undefined {
    if (this.ended) return undefined;
    this.ended = true;
    const seconds = Math.round((Date.now() - this.started) / 100) / 10;
    const end = { stop, exitCode, steps: this.step, usage: inOrder(this.usage), cost: this.cost, seconds };
    this.write("end", { ...end });
    if (this.fd !== undefined) closeSync(this.fd);
    return end;
  }

  private write(type: string, fields: Record<string, unknown>): void {
    if (this.ended && type !== "end") return;
    const event = redact({ v: 1, seq: ++this.seq, ts: new Date().toISOString(), type, ...fields }).value as Event;
    if (this.listener) return this.listener(event);
    const line = `${JSON.stringify(event)}\n`;
    if (this.fd === undefined) process.stdout.write(line);
    else writeSync(this.fd, line);
  }
}

/** Tokens in the contract's order of fields. */
function inOrder({ input, cacheRead, cacheWrite, output }: Usage): Usage {
  return { input, cacheRead, cacheWrite, output };
}
