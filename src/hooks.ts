import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Hook, HookEvent } from "./settings.ts";
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
 * outside the sandbox.
 */
export async function runHooks(
  hooks: Hook[],
  event: HookEvent,
  call: { tool: string; input: ToolInput; output?: string },
  cwd: string,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { warnings: [] };
  const matching = hooks.filter((hook) => hook.event === event && (!hook.matcher || new RegExp(`^(?:${hook.matcher})$`).test(call.tool)));
  for (const hook of matching) {
    const file = typeof call.input.path === "string" ? resolve(cwd, call.input.path) : "";
    const env = { ...process.env, JIG_EVENT: event, JIG_TOOL: call.tool, JIG_FILE: file, JIG_PROJECT_DIR: cwd };
    const { code, stderr } = await run(hook.command, JSON.stringify({ event, ...call, cwd }), cwd, env);
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

function run(command: string, stdin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("bash", ["-c", command], { cwd, env, stdio: ["pipe", "ignore", "pipe"], timeout: TIMEOUT });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => done({ code: null, stderr: err.message }));
    child.on("close", (code, signal) => done({ code: code ?? null, stderr: signal ? `${stderr}\n(killed: ${signal})` : stderr }));
    child.stdin.on("error", () => {}); // the hook may exit without reading its input
    child.stdin.end(stdin);
  });
}
