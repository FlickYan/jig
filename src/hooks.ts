import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { hookMatcher, type Hook, type HookEvent } from "./settings.ts";
import { envWithoutKeys, LINGER_MS } from "./tools/bash.ts";
import type { ToolInput } from "./tools/index.ts";

const TIMEOUT = 60_000;

export interface HookOutcome {
  /** A PreToolUse hook blocked the call; this is why (sent to the model). */
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
  event: HookEvent,
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
    const { code, stderr } = await run(hook.command, JSON.stringify({ event, ...call, cwd }), cwd, env, timeout, signal);
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

/**
 * Runs one hook the way bash.ts runs commands: in a process group of its own, so a timeout or Ctrl+C
 * kills everything it started, not just the shell. Once the shell has exited, a job it left in the
 * background may hold stderr open; jig waits a moment for its last words, then goes on and leaves it.
 */
function run(command: string, stdin: string, cwd: string, env: NodeJS.ProcessEnv, timeout: number, signal?: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
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
      done({ code, stderr: killedBecause ? `${stderr}\n(killed: ${killedBecause})` : `${stderr}${note}` });
    };
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (!finished) stderr += chunk;
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("exit", (code) => {
      lingering = setTimeout(() => {
        (child.stderr as Partial<Socket>).unref?.(); // keep reading, so the job never blocks on a full pipe
        finish(code);
      }, LINGER_MS);
    });
    child.on("close", (code, killSignal) => finish(code, killSignal ? `\n(killed: ${killSignal})` : ""));
    child.stdin.on("error", () => {}); // the hook may exit without reading its input
    child.stdin.end(stdin);
  });
}
