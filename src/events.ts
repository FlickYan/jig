// --events: a one-shot task as JSON lines, for a backend that runs jig as a task and follows it there
// rather than in the terminal's output. One object a line, each written as it happens, with what the
// terminal shows (the steps, the tool calls and their results, the notices) and how the task ended.
// Where an approver answers in the terminal's place (--approve-via's service, or a library's), the calls put
// to it and its answers too. Each model call that isn't a step's (the wrap-up, a compaction, a subagent's, the
// reviewer's) is a call event, so the steps' and the calls' costs add up to the end's.
// The fields are a contract (version 1): a reader ignores a type it doesn't know, and a field may be added.
// A library's task (lib.ts) gets the same objects, handed to its listener instead of written.

import { closeSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { addUsage, type AgentUI, type Usage, WRAP_UP } from "./agent.ts";
import { redact } from "./export.ts";
import type { CallModel } from "./model.ts";
import { costOf } from "./prices.ts";
import { truncate } from "./tools/index.ts";
import { notice } from "./ui.ts";

/**
 * The most of a tool's output, or of a tool call's description, an event holds: the terminal shows a few
 * lines, a backend wants more.
 */
export const EVENT_OUTPUT_CHARS = 4_000;
// The most of an approval request's description: the person deciding should see the whole diff where they can,
// but a line over a mebibyte is dropped by the service's runners, and the call then waits for an answer in vain.
const APPROVAL_DESCRIPTION_CHARS = 64_000;
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
 * through, as --stats' file is. A path in /dev or /proc is written to as it is. Each event is written as
 * it happens, so a crash loses at most the line being written; one a pipe on stdout has no room for waits in
 * jig (see Lines), and at the end jig waits for the reader to take it, up to FLUSH_SECONDS without
 * progress, and END_FLUSH_SECONDS in all (SIGNAL_FLUSH_SECONDS after a signal). Every string goes through
 * the redaction `jig sessions export` uses.
 */
export class Events {
  private readonly fd: number | undefined; // undefined: stdout, or the listener
  private readonly lines: Lines | undefined; // undefined: the listener
  private readonly listener: ((event: Event) => void) | undefined;
  private readonly model: string;
  private readonly started = Date.now();
  private seq = 0;
  private step = 0; // the loop's step, for the tool calls and text that come in it
  private readonly usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  private cost: number | null;
  private metered = false; // whether a call has been priced: until then the cost is the task's model's
  private ended = false;
  // What a listener threw at a call or an approval event, until the task fails with it (see meter, kept).
  private failed: { error: unknown } | undefined;
  /** The end's exit code, once it is written: a signal after it doesn't change how jig exits. */
  endedWith: number | undefined;

  constructor(path: string | ((event: Event) => void), model: string, io?: Io) {
    this.model = model;
    this.cost = costOf(model, this.usage) ?? null;
    if (typeof path === "function") this.listener = path;
    if (typeof path === "function") return;
    if (path === "-") {
      // Node makes process.stdout on a pipe or a socket with libuv's uv_pipe_open or uv_tcp_open, which make
      // fd 1 non-blocking, on Linux as on macOS: a write the reader has no room for then fails with EAGAIN
      // rather than blocking jig in the kernel, where no signal handler can run. Made here (ui.ts has made it
      // already) and never written to: a file or a terminal on fd 1 stays blocking, and takes each line at once.
      void process.stdout;
      this.lines = new Lines(1, io);
      return;
    }
    if (/^\/(dev|proc)\//.test(path)) {
      this.fd = openSync(path, "a");
      this.lines = new Lines(this.fd, io);
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
    this.lines = new Lines(this.fd, io);
  }

  start(start: Start): void {
    this.write("start", { ...start });
  }

  /** The terminal's UI, with each step, tool call and result written as an event too. */
  ui(base: AgentUI): AgentUI {
    return {
      ...base,
      step: (step, reply) => {
        this.check();
        base.step?.(step, reply);
        this.step = step;
        const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
        addUsage(usage, reply.usage);
        // Priced as meter prices the call for the end, so the steps' costs add up to the end's.
        const cost = (reply.served !== undefined ? costOf(reply.served, usage) : undefined) ?? costOf(reply.model ?? this.model, usage);
        this.write("step", { step, usage: inOrder(usage), cost: cost ?? null });
        if (reply.text.trim()) this.text(reply.text);
      },
      toolCall: (name, description, id) => {
        this.check();
        base.toolCall(name, description, id);
        // A command or a diff can be any length: the terminal shows its first lines.
        const [shown, truncated] = cut(description, EVENT_OUTPUT_CHARS);
        this.write("tool_call", { step: this.step, id, name, description: shown, ...(truncated && { truncated }) });
      },
      toolResult: (output, isError, id) => {
        this.check();
        base.toolResult(output, isError, id);
        const [shown, truncated] = cut(output, EVENT_OUTPUT_CHARS);
        this.write("tool_result", { step: this.step, id, isError, output: shown, ...(truncated && { truncated }) });
      },
    };
  }

  /**
   * A subagent's or the reviewer's UI, whose tool calls are no events: what a listener threw at a call event
   * (see meter) stops them too, before any of a call runs, its hooks included.
   */
  checked(base: AgentUI): AgentUI {
    return {
      ...base,
      toolCall: (name, description, id) => (this.check(), base.toolCall(name, description, id)),
      toolResult: (output, isError, id) => (this.check(), base.toolResult(output, isError, id)),
    };
  }

  /**
   * The same model, its usage and cost added to the end's: `model` is whose calls they are. The task's own
   * model's calls (and --escalate's) are steps, which ui writes, but for those that summarize: the wrap-up,
   * known by its request, and a compaction. Those and every call of a subagent's or the reviewer's model
   * (`kind`) are written here as calls, with what they were for and the main loop's step they came in, or
   * the last before them. A listener that throws there doesn't fail the call: each caller takes a failed call
   * its own way (a subagent's is its tool's result, a wrap-up's is left out), and the task would go on. Its
   * error is kept, and thrown at the next model call, step, tool call or result (a subagent's or the
   * reviewer's too, see checked), or by check once the loop is over, so the task ends with it, as it does when
   * the listener throws at any other event.
   */
  meter(callModel: CallModel, model: string, kind?: "subagent" | "review"): CallModel {
    return async (messages, signal, options) => {
      this.check();
      const turn = await callModel(messages, signal, options);
      const what = kind ?? (!options?.summarize ? undefined : messages.at(-1)?.content === WRAP_UP ? "wrap-up" : "compaction");
      const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      addUsage(usage, turn.message.usage);
      addUsage(this.usage, turn.message.usage);
      // Priced by the model the reply names when it has a price, as the gateway prices it: an alias jig
      // has no price for (a gateway's my-opus for claude-opus-5-5) then still has a cost.
      const served = turn.message.model;
      const cost = (typeof served === "string" ? costOf(served, usage) : undefined) ?? costOf(model, usage);
      // Before the first call, the cost is null for a task's model without a price, which its replies may have.
      const before = this.metered ? this.cost : 0;
      this.metered = true;
      // One call of a model without a price leaves the whole without one.
      this.cost = before === null || cost === undefined ? null : before + cost;
      try {
        if (what) this.write("call", { for: what, step: this.step, usage: inOrder(usage), cost: cost ?? null });
      } catch (error) {
        this.failed ??= { error };
      }
      return turn;
    };
  }

  /** Throws what a listener threw at a call event, if it did (see meter). */
  check(): void {
    if (this.failed) throw this.failed.error;
  }

  /** The model's text in the current step (or the wrap-up's after the last). */
  text(text: string): void {
    this.write("text", { step: this.step, text });
  }

  notice(text: string): void {
    this.write("notice", { text });
  }

  /** A tool call put to the approver, before it is asked: the service learns of it here (see approvals.ts). */
  approvalRequest(request: { step: number; id: string; tool: string; description: string }): void {
    const { step, id, tool } = request;
    const [description, truncated] = cut(request.description, APPROVAL_DESCRIPTION_CHARS);
    this.kept("approval_request", { step, id, tool, description, ...(truncated && { truncated }) });
  }

  /** The approver's answer, or the timeout's deny, as the call goes on with it. */
  approval(answer: { id: string; decision: "allow" | "deny"; always: boolean; by: "api" | "timeout" }): void {
    this.kept("approval", { ...answer });
  }

  /** How the task ended, and the code jig exits with. Only the first end is written, and returned. */
  end(stop: string, exitCode: number): End | undefined {
    if (this.ended) return undefined;
    // The events dropped while the reader was too far behind, said before the end where there is room by now.
    const dropped = this.lines?.dropped ?? 0;
    if (dropped) this.notice(`${count(dropped)} written: the --events reader was too far behind.`);
    this.ended = true;
    this.endedWith = exitCode;
    const seconds = Math.round((Date.now() - this.started) / 100) / 10;
    const end = { stop, exitCode, steps: this.step, usage: inOrder(this.usage), cost: this.cost, seconds };
    this.write("end", { ...end });
    // However jig ends, the end is written (by its exit handler, at worst): what Lines holds goes with it.
    // After a signal, an orchestrator's SIGKILL is coming: the reader gets SIGNAL_FLUSH_SECONDS in all. While
    // it waits, a second Ctrl+C, SIGTERM or SIGHUP would end jig by the signal's default action where jig has
    // no handler left for it (Ctrl+C's goes with the task, SIGTERM's runs once), losing the end without a word.
    // Each is ignored until that wait is over; jig then exits as the first signal had it. Only that wait: at
    // another end Ctrl+C must still stop jig at once. A SIGTERM there is acted on once the wait is over, so it
    // has a bound in all too, END_FLUSH_SECONDS, however steadily the reader reads.
    const interrupted = stop === "interrupted";
    const ignore = () => {};
    if (this.lines && interrupted) for (const signal of SIGNALS) process.on(signal, ignore);
    try {
      if (interrupted) this.lines?.flush(SIGNAL_FLUSH_SECONDS, "after a signal");
      else this.lines?.flush(END_FLUSH_SECONDS, "without a signal");
    } finally {
      for (const signal of SIGNALS) process.off(signal, ignore);
    }
    if (this.fd !== undefined) closeSync(this.fd);
    return end;
  }

  /**
   * A write in a tool call's permission check, which the loop takes, if it throws, for a failed check: the
   * call's result would say so, and the task go on. The call still doesn't run, and what the listener threw
   * is kept too, so the call's result throws it again and the task ends with it (see meter).
   */
  private kept(type: string, fields: Record<string, unknown>): void {
    try {
      this.write(type, fields);
    } catch (error) {
      this.failed ??= { error };
      throw error;
    }
  }

  private write(type: string, fields: Record<string, unknown>): void {
    if (this.ended && type !== "end") return;
    const event = redact({ v: 1, seq: ++this.seq, ts: new Date().toISOString(), type, ...fields }).value as Event;
    if (this.listener) return this.listener(event);
    // Not process.stdout.write: what the pipe couldn't take waited in Node, and the exit a signal brings
    // lost it, the end with it. What Lines holds, end writes before jig exits.
    this.lines?.write(`${JSON.stringify(event)}\n`, type === "end");
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** How long jig, at its end, waits for a reader that takes none of the events it holds before it gives up on them. */
export const FLUSH_SECONDS = 5;
/**
 * How long in all jig waits for the reader at an end a signal brought, however steadily it reads: inside the
 * 30 s Kubernetes gives a pod between SIGTERM and SIGKILL. jig's own cleanup is done before (see run.ts).
 */
export const SIGNAL_FLUSH_SECONDS = 20;
/**
 * How long in all jig waits for the reader at an end no signal brought: long enough for a slow reader of a
 * normal run, while a SIGTERM that comes in the wait, whose handler can't run until it is over, isn't put off
 * for good.
 */
export const END_FLUSH_SECONDS = 60;
/** The most of the lines jig holds for a reader that is behind: past it, events are dropped (not the end). */
export const HELD_BYTES = 64 * 1024 * 1024;
// While the reader is behind, how often jig tries again to write the lines it holds.
const RETRY_MS = 10;

/** What Lines writes with: fs.writeSync, the clock and a wait that doesn't spin, or a test's. */
export interface Io {
  write(fd: number, data: Uint8Array): number;
  now(): number;
  wait(ms: number): void;
}

const pause = new Int32Array(new SharedArrayBuffer(4)); // nothing wakes it: each wait is the time given
const system: Io = { write: (fd, data) => writeSync(fd, data), now: Date.now, wait: (ms) => Atomics.wait(pause, 0, 0, ms) };

/**
 * Lines written to `fd` whole and in order, without holding jig up while the fd is a pipe whose reader is
 * behind (the fd is then non-blocking, see Events). What the pipe can't take now, the rest of a line or all
 * of it, waits here, every later line behind it, and is tried again every few milliseconds, on a timer that
 * doesn't keep jig alive. jig never waits for the reader while it runs, so it acts on a signal even when the
 * reader takes nothing: while a write waited, its signal handlers couldn't run. A file or a terminal takes
 * each line at once. What is held is bounded: past `limit` bytes a new line is dropped whole, and counted, as
 * otherwise a reader that takes nothing would have jig keep every event of the run.
 */
export class Lines {
  private readonly held: Uint8Array[] = [];
  private bytes = 0; // held
  private timer: NodeJS.Timeout | undefined;
  private written = 0; // bytes, to tell whether the reader took any
  private gone = false; // the reader closed the pipe, or a write tried again failed
  private readonly fd: number;
  private readonly io: Io;
  private readonly limit: number;
  /** The lines dropped past the limit. */
  dropped = 0;

  constructor(fd: number, io = system, limit = HELD_BYTES) {
    this.fd = fd;
    this.io = io;
    this.limit = limit;
  }

  /** Writes `line`, or holds it; past the limit drops it, unless it is the end (`always`). */
  write(line: string, always = false): void {
    if (this.gone) return;
    const data = Buffer.from(line);
    if (!always && this.bytes + data.length > this.limit) return void this.dropped++;
    this.held.push(data);
    this.bytes += data.length;
    if (this.held.length === 1) this.drain();
  }

  /** Writes what the fd takes now, and tries the rest again a moment later. */
  drain(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.take()) this.timer = setTimeout(() => this.retry(), RETRY_MS).unref();
  }

  /**
   * At the end: waits for the reader to take what is held, as long as it takes some every FLUSH_SECONDS (and,
   * given `total`, for that many seconds at most, the end being `when`), then gives up on the rest, saying so.
   * Returns how many lines weren't written whole (the first of them perhaps in part).
   */
  flush(total?: number, when = "after a signal"): number {
    clearTimeout(this.timer);
    let written = this.written;
    const begun = this.io.now();
    let since = begun;
    let why = "";
    while (!this.taken()) {
      const now = this.io.now();
      if (this.written > written) [written, since] = [this.written, now];
      else if (now - since >= FLUSH_SECONDS * 1000) why = `took nothing for ${FLUSH_SECONDS} s`;
      if (total !== undefined && now - begun >= total * 1000) why = `didn't take them all in the ${total} s jig gives it ${when}`;
      if (why) break;
      this.io.wait(5);
    }
    const lost = this.held.length;
    this.lose();
    if (lost) notice(`The --events reader ${why}: ${count(lost)} written.`);
    const size = this.limit % 2 ** 20 ? `${this.limit} bytes` : `${this.limit / 2 ** 20} MiB`;
    if (this.dropped) notice(`The --events reader was too far behind: ${count(this.dropped)} written, past the ${size} jig holds for it.`);
    return lost;
  }

  // The retry, on a timer: a write failing there with something other than EAGAIN or EPIPE (EIO, say) would
  // be an exception nothing catches, so the reader counts as gone, as after EPIPE.
  private retry(): void {
    try {
      this.drain();
    } catch (error) {
      this.gone = true;
      this.lose();
      notice(`The --events reader is gone (a write failed: ${(error as NodeJS.ErrnoException).code ?? String(error)}): jig writes no more events, and goes on with the task.`);
    }
  }

  /**
   * take, at the end: a write failing otherwise than EAGAIN or EPIPE (EIO, say) would throw out of jig's exit
   * handler, so the reader counts as gone, as in the retry.
   */
  private taken(): boolean {
    try {
      return this.take();
    } catch (error) {
      const lost = this.held.length;
      this.gone = true;
      this.lose();
      notice(`The --events reader is gone (a write failed: ${(error as NodeJS.ErrnoException).code ?? String(error)}): ${count(lost)} written.`);
      return true;
    }
  }

  /** Lets go of what is held. */
  private lose(): void {
    this.held.length = 0;
    this.bytes = 0;
  }

  /** Writes held lines until the fd takes no more. Whether none is left. */
  private take(): boolean {
    while (this.held.length) {
      const line = this.held[0];
      let taken: number;
      try {
        taken = this.io.write(this.fd, line);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") return false; // the pipe is full: the reader is behind
        if (code !== "EPIPE") throw error;
        // The reader closed the pipe: no one follows the events now, but the task can still be done.
        this.gone = true;
        this.lose();
        notice("The --events reader is gone (its pipe was closed): jig writes no more events, and goes on with the task.");
        return true;
      }
      this.written += taken;
      this.bytes -= taken;
      if (taken < line.length) this.held[0] = line.subarray(taken);
      else this.held.shift();
    }
    return true;
  }
}

/**
 * `text` as an event holds it, at most `max` characters, cut from the middle, and whether it was cut. Redacted
 * before the cut, so that a key cut in two isn't left half there.
 */
function cut(text: string, max: number): [string, boolean] {
  const whole = redact(text).value;
  return whole.length > max ? [truncate(whole, max - CUT_LINE), true] : [whole, false];
}

/** "1 event wasn't", or "n events weren't". */
function count(events: number): string {
  return events === 1 ? "1 event wasn't" : `${events} events weren't`;
}

/** Tokens in the contract's order of fields. */
function inOrder({ input, cacheRead, cacheWrite, output }: Usage): Usage {
  return { input, cacheRead, cacheWrite, output };
}
