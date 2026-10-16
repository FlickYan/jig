import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { hookMatcher, type Hook, type HookEvent } from "./settings.ts";
import { envWithoutKeys, LINGER_MS } from "./tools/bash.ts";
import type { ToolInput } from "./tools/index.ts";

const TIMEOUT = 60_000;

export interface HookOutcome {
  /** A PreToolUse hook blocked the call, or a Stop hook the end of the task; this is why (sent to the model). */
  block?: string;
  /** A PostToolUse hook has something to tell the model about the result, like lint errors. */
  feedback?: string;
  /** Hooks that failed to run properly, for the user. */
  warnings: string[];
}

/**
 * Runs the hooks for one tool call, the way Claude Code's work: each gets the call as JSON on stdin
 * (plus JIG_TOOL, JIG_FILE and JIG_PROJECT_DIR in its environment). Exit code 0 lets things go on; exit
 * code 2 blocks the call (PreToolUse) or sends stderr to the model (PostToolUse); anything else is a
 * broken hook, reported to the user but not blocking. Hooks are the user's own commands, so they run
 * outside the sandbox, but like the model's commands they don't get jig's API keys.
 */
export async function runHooks(
  hooks: Hook[],
  event: Exclude<HookEvent, "Stop">,
  call: { tool: string; input: ToolInput; output?: string },
  cwd: string,
  { signal, timeout = TIMEOUT }: { signal?: AbortSignal; timeout?: number } = {},
): Promise<HookOutcome> {
  const outcome: HookOutcome = { warnings: [] };
  const matching = hooks.filter((hook) => hook.event === event && hookMatcher(hook.matcher).test(call.tool));
  for (const hook of matching) {
    if (signal?.aborted) break;
    const file = typeof call.input.path === "string" ? resolve(cwd, call.input.path) : "";
    const env = { ...envWithoutKeys(), JIG_EVENT: event, JIG_TOOL: call.tool, JIG_FILE: file, JIG_PROJECT_DIR: cwd };
    const { code, stderr } = await run(hook.command, JSON.stringify({ event, ...call, cwd }), cwd, env, { timeout, signal });
    if (code === 0) continue;
    const message = stderr.trim() || `the hook exited with code ${code}`;
    if (code !== 2) {
      outcome.warnings.push(`Hook "${hook.command}" failed: ${message}`);
    } else if (event === "PreToolUse") {
      return { ...outcome, block: message };
    } else {
      outcome.feedback = [outcome.feedback, message].filter(Boolean).join("\n");
    }
  }
  return outcome;
}

/** What a Stop hook gets on stdin, besides the event and the project directory. */
export interface StopInput {
  task: string;
  /** The model's final answer. */
  last_message: string;
  /** Whether the Stop hooks have already sent the model back in this task, named as in Claude Code. */
  stop_hook_active: boolean;
  /** The session file. */
  session_path?: string;
  /** The files the task changed, created or deleted, by the snapshot taken before it (none: /undo is off). */
  changed_files?: string[];
}

/**
 * Runs the Stop hooks once the model has given its final answer, the way Claude Code's work: each gets
 * the task and the answer as JSON on stdin, and keeps the task from ending by exiting with code 2 (the
 * model is told its stderr) or by printing {"decision": "block", "reason": "..."} (the model is told the
 * reason). There is no tool, so matchers don't apply. Every hook runs, so the model hears all that is
 * still wrong at once; a hook that fails otherwise is reported to the user but doesn't block.
 */
export async function runStopHooks(hooks: Hook[], stop: StopInput, cwd: string, { signal, timeout = TIMEOUT }: { signal?: AbortSignal; timeout?: number } = {}): Promise<HookOutcome> {
  const outcome: HookOutcome = { warnings: [] };
  for (const hook of hooks.filter((hook) => hook.event === "Stop")) {
    if (signal?.aborted) break;
    const env = { ...envWithoutKeys(), JIG_EVENT: "Stop", JIG_PROJECT_DIR: cwd };
    const { code, stdout, stderr } = await run(hook.command, JSON.stringify({ event: "Stop", ...stop, cwd }), cwd, env, { timeout, signal, readStdout: true });
    const message = stderr.trim() || `the hook exited with code ${code}`;
    const reason = code === 2 ? message : code === 0 ? blockReason(stdout) : undefined;
    if (reason !== undefined) outcome.block = [outcome.block, reason].filter(Boolean).join("\n");
    else if (code !== 0) outcome.warnings.push(`Hook "${hook.command}" failed: ${message}`);
  }
  return outcome;
}

/** The reason a hook gave on stdout for blocking, if what it printed is Claude Code's {"decision": "block"}. */
function blockReason(stdout: string): string | undefined {
  let output: { decision?: unknown; reason?: unknown } | null;
  try {
    output = JSON.parse(stdout);
  } catch {
    return undefined; // anything else a hook prints is its own business
  }
  if (output?.decision !== "block") return undefined;
  return typeof output.reason === "string" && output.reason.trim() ? output.reason.trim() : "the hook gave no reason";
}

/**
 * Runs one hook the way bash.ts runs commands: in a process group of its own, so a timeout or Ctrl+C
 * kills everything it started, not just the shell. Once the shell has exited, a job it left in the
 * background may hold its output open; jig waits a moment for its last words, then goes on and leaves it.
 * Only Stop hooks have their stdout read; a tool hook's goes nowhere, so a job holding it isn't waited for.
 */
function run(
  command: string,
  stdin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  { timeout, signal, readStdout = false }: { timeout: number; signal?: AbortSignal; readStdout?: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    // stdin and stderr are always pipes, so only stdout can be missing.
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["pipe", readStdout ? "pipe" : "ignore", "pipe"] }) as ChildProcessByStdio<Writable, Readable | null, Readable>;
    let stdout = "";
    let stderr = "";
    let killedBecause = "";
    let finished = false;
    const kill = (reason: string) => {
      killedBecause ||= reason;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // the process group has already exited
      }
    };
    const timer = setTimeout(() => kill(`it timed out after ${timeout / 1000}s`), timeout);
    const onAbort = () => kill("the user interrupted it");
    signal?.addEventListener("abort", onAbort, { once: true });
    let lingering: NodeJS.Timeout | undefined;
    const finish = (code: number | null, note = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(lingering);
      signal?.removeEventListener("abort", onAbort);
      done({ code, stdout, stderr: killedBecause ? `${stderr}\n(killed: ${killedBecause})` : `${stderr}${note}` });
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (!finished) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (!finished) stderr += chunk;
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("exit", (code) => {
      lingering = setTimeout(() => {
        // Keep reading, so the job never blocks on a full pipe, without keeping jig alive.
        for (const stream of [child.stdout, child.stderr]) (stream as Partial<Socket> | null)?.unref?.();
        finish(code);
      }, LINGER_MS);
    });
    child.on("close", (code, killSignal) => finish(code, killSignal ? `\n(killed: ${killSignal})` : ""));
    child.stdin.on("error", () => {}); // the hook may exit without reading its input
    child.stdin.end(stdin);
  });
}
