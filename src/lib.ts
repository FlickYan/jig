// jig as a library: runTask() runs one task, as `jig --events - "task"` would, in the program that calls it.
// Its events are the --events objects, handed to a listener; a signal stops it, and a callback approves the
// tool calls the CLI would ask about at a terminal. It prints nothing, and leaves the process alone: no
// signal handlers, no exit code, no chdir. Several can run at once in one process, each with its own
// project, jig directory, model and API (see context.ts), and see only their own events, permissions,
// memories, sessions and stats. It runs the CLI's own code (run.ts), so the two can't drift.

import { resolve } from "node:path";
import type { Usage } from "./agent.ts";
import type { Event } from "./events.ts";
import { type Mode, MODES } from "./permissions.ts";
import { type Approval, type ApprovalRequest, type Ending, parseOptions, run, type Values } from "./run.ts";

export type { Approval, ApprovalRequest, Event, Mode, Usage };

export interface TaskOptions {
  prompt: string;
  /** The project's directory; a relative one is from the process's working directory. */
  cwd: string;
  /** jig's default (deepseek-flash) without one. */
  model?: string;
  /** The API's address, as --base-url. */
  baseUrl?: string;
  /** The API key; without one, from the environment variable jig uses for the model (ANTHROPIC_API_KEY, ...). */
  apiKey?: string;
  /** 50 without one. */
  maxSteps?: number;
  /** Seconds, as --time-limit. */
  timeLimit?: number;
  /** When to ask before a tool call, as --mode: edits without one. */
  mode?: Mode;
  /** As --yes: the mode is auto. */
  yes?: boolean;
  /** jig's directory, for $JIG_HOME (or ~/.jig): sessions, snapshots, memories, settings. */
  home?: string;
  /**
   * The environment the task's commands and hooks get (less the API keys), and its MCP servers their HOME,
   * PATH and the like from, for the process's. It is also where JIG_TRUST_PROJECT is read: pass it here to
   * trust a project's settings.
   */
  env?: Record<string, string>;
  /** Stops the task: it ends `interrupted`. */
  signal?: AbortSignal;
  /**
   * Each event, as --events would write it, as it happens. A listener that throws ends the task with stop
   * "error" and its message; one that throws at the end event (or at every event) makes runTask reject with
   * its error.
   */
  onEvent?: (event: Event) => void;
  /**
   * Asked where the CLI would ask at a terminal. Without it, and without `yes`, such a call is denied, as with
   * no terminal: the third ends the task `unapproved`. If it rejects, the call doesn't run (its result tells
   * the model the permission check failed, with the error's message), its approval_request gets no approval
   * event, and the task goes on.
   */
  approve?: (request: ApprovalRequest, signal: AbortSignal) => Promise<Approval>;
  /** false: commands run directly on this machine, as --no-sandbox. */
  sandbox?: boolean;
  /** A path for the --stats file; a relative one is from the process's working directory, as for `cwd`. */
  stats?: string;
}

/** How the task ended: its end event's fields, and the final reply's text. */
export interface TaskResult {
  stop: Ending;
  /** What `jig` would exit with: 0 when the model finished, 2 out of steps, 130 interrupted, ... */
  exitCode: number;
  steps: number;
  usage: Usage;
  /** In US dollars; null for a model without a price. */
  cost: number | null;
  seconds: number;
  /** The final reply's text (out of steps, the wrap-up's report). */
  text: string;
  /** What failed, where `stop` is "error". */
  error?: string;
}

/**
 * Runs a task to its end. Rejects only when the options are wrong, before the task starts, or when onEvent
 * throws at the end; however the task then ends, a failure included, it resolves to how, as the end event
 * says.
 */
export async function runTask(options: TaskOptions): Promise<TaskResult> {
  if (!options.prompt?.trim()) throw new Error("runTask needs a prompt.");
  // Checked here under the names the caller used; run.ts's checks name the command line's flags.
  const { maxSteps, timeLimit, mode } = options;
  if (maxSteps !== undefined && !(Number.isInteger(maxSteps) && maxSteps >= 1)) throw new Error("runTask: maxSteps must be a positive integer");
  if (timeLimit !== undefined && !(timeLimit > 0 && timeLimit * 1000 < 2 ** 31)) throw new Error("runTask: timeLimit must be a positive number of seconds, under 24 days");
  if (mode !== undefined && !MODES.includes(mode)) throw new Error(`runTask: mode must be one of: ${MODES.join(", ")}`);
  // The command line's defaults, so a task here runs as one given there would.
  const values: Values = {
    ...parseOptions([]).values,
    cwd: resolve(options.cwd),
    ...(options.model !== undefined && { model: options.model }),
    "base-url": options.baseUrl,
    ...(options.maxSteps !== undefined && { "max-steps": String(options.maxSteps) }),
    "time-limit": options.timeLimit === undefined ? undefined : String(options.timeLimit),
    ...(options.mode !== undefined && { mode: options.mode }),
    yes: options.yes ?? false,
    sandbox: options.sandbox,
    stats: options.stats,
  };
  const library = {
    context: { home: options.home, env: options.env, silent: true },
    apiKey: options.apiKey,
    signal: options.signal,
    onEvent: options.onEvent ?? (() => {}),
    approve: options.approve,
  };
  const outcome = await run(values, { given: options.prompt }, library);
  // Only a listener that threw at the end event leaves none.
  if (!outcome?.end) throw new Error(outcome?.error ?? "The task ended without an end event.");
  const { steps, usage, cost, seconds } = outcome.end;
  return { stop: outcome.stop, exitCode: outcome.exitCode, steps, usage, cost, seconds, text: outcome.text, ...(outcome.error !== undefined && { error: outcome.error }) };
}
