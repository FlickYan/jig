import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Sandbox } from "../sandbox.ts";
import type { Tool } from "./index.ts";
import { parseCommand } from "./shell.ts";
import { type FileVersions, isInside } from "./util.ts";

const DEFAULT_TIMEOUT = 120; // seconds
// jig's own credentials. The commands the model runs never need them, and they shouldn't see them: in
// the Terminal-Bench runs the model printed the environment with `env` to look around, which put the key
// into the conversation and the logs, and a prompt injection could send it somewhere instead.
const PRIVATE_ENV = ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const MAX_TIMEOUT = 600;
const MAX_CAPTURE = 5_000_000; // characters; a command printing more than this is killed
const LINGER_MS = 1000; // how long to wait, once the shell has exited, for a background job's last output
const STILL_RUNNING =
  "(The command has finished, but something it started in the background is still running with this output " +
  "open. jig didn't wait for it, so its later output isn't shown.)";

const ABOUT = "Run a shell command with bash in the working directory. Returns stdout and stderr combined, then the exit code.";
const RULES =
  "Each call starts a fresh shell, so cd and variables do not carry over: chain commands with && instead. There is " +
  "no stdin, so anything interactive gets end-of-file; use non-interactive flags. To leave a server running, start " +
  "it in the background with its output redirected to a file.";

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description:
      `${ABOUT} Use it to run tests, builds and git; to search or read files, the grep, glob and read_file tools ` +
      `are usually better. ${RULES}`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout: { type: "integer", description: `Seconds before the command is killed (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})` },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  kind: "run",
  describe: ({ command }) => String(command),

  async run(input, { cwd, signal, versions, sandbox, dirs = [] }) {
    const { command, timeout = DEFAULT_TIMEOUT } = input as { command: string; timeout?: number };
    const seconds = Math.min(Math.max(timeout, 1), MAX_TIMEOUT);
    const output = await runCommand(command, cwd, seconds, signal, sandbox);
    await recordViewedFiles(command, cwd, versions, dirs);
    return output;
  },
};

// Programs that print a file's content. Models often look at files this way instead of with read_file.
const VIEWERS = new Set(["cat", "head", "tail", "nl"]);

/**
 * A file the model printed with `cat` (or head, tail) counts as read for edit_file's read-before-edit
 * check. The benchmark showed why: without this, edits after a `cat` were refused and had to be redone.
 */
async function recordViewedFiles(command: string, cwd: string, versions: FileVersions, dirs: string[]): Promise<void> {
  for (const [program, ...args] of parseCommand(command) ?? []) {
    if (!VIEWERS.has(program)) continue;
    for (const arg of args) {
      const abs = resolve(cwd, arg);
      if (arg.startsWith("-") || ![cwd, ...dirs].some((dir) => isInside(dir, abs))) continue;
      const info = await stat(abs).catch(() => null);
      if (info?.isFile()) await versions.record(abs, info);
    }
  }
}

export function runCommand(command: string, cwd: string, seconds: number, signal?: AbortSignal, sandbox?: Sandbox): Promise<string> {
  return new Promise((resolve, reject) => {
    const { program, args } = sandbox?.wrap(command) ?? { program: "bash", args: ["-c", command] };
    // detached puts the command in its own process group, so a timeout or Ctrl+C can kill it together
    // with everything it started (a test runner and its workers, say), not just the shell.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !PRIVATE_ENV.includes(name)));
    const child = spawn(program, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let killedBecause = "";
    let done = false;
    const kill = (reason: string) => {
      killedBecause ||= reason;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // the process group has already exited
      }
    };
    const collect = (chunk: string) => {
      if (done) return; // a background job's output, after the call has returned
      output += chunk;
      if (output.length > MAX_CAPTURE) kill(`it printed more than ${MAX_CAPTURE} characters`);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);

    const timer = setTimeout(() => kill(`it timed out after ${seconds}s`), seconds * 1000);
    const onAbort = () => kill("the user interrupted it");
    signal?.addEventListener("abort", onAbort, { once: true });
    let lingering: NodeJS.Timeout | undefined;
    const settle = () => {
      done = true;
      clearTimeout(timer);
      clearTimeout(lingering);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (status: string, note = "") => {
      if (done) return;
      settle();
      resolve(`${output.trimEnd() || "(no output)"}\n\n${note ? `${note}\n` : ""}${status}`);
    };
    const status = (code: number | null, killSignal: NodeJS.Signals | null) =>
      killedBecause ? `Killed: ${killedBecause}.` : `Exit code: ${code ?? killSignal}`;

    child.on("error", (err) => {
      settle();
      reject(err);
    });
    // "close" comes once the output pipes have closed, which is normally when the command has finished.
    // But a job it left in the background can hold them: `cd app && server > log &` runs the whole list
    // in a subshell, which keeps the pipes while it waits for the server. So once the shell has exited,
    // wait a moment for the last output, then return and leave the job running, as a terminal would.
    child.on("exit", (code, killSignal) => {
      lingering = setTimeout(() => {
        // Keep reading what the job prints, so it never blocks on a full pipe, without keeping jig alive.
        for (const stream of [child.stdout, child.stderr]) (stream as Partial<Socket>).unref?.();
        finish(status(code, killSignal), STILL_RUNNING);
      }, LINGER_MS);
    });
    child.on("close", (code, killSignal) => finish(status(code, killSignal)));
  });
}

/** bash without jig's search and read tools beside it (--tools): its description doesn't point at them. */
export const bashOnItsOwn: Tool = { ...bashTool, definition: { ...bashTool.definition, description: `${ABOUT} ${RULES}` } };
