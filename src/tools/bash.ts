import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool } from "./index.ts";
import { parseCommand } from "./shell.ts";
import { type FileVersions, isInside } from "./util.ts";

const DEFAULT_TIMEOUT = 120; // seconds
const MAX_TIMEOUT = 600;
const MAX_CAPTURE = 5_000_000; // characters; a command printing more than this is killed

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description:
      "Run a shell command with bash in the working directory. Returns stdout and stderr combined, then the " +
      "exit code. Use it to run tests, builds and git; to search or read files, the grep, glob and read_file " +
      "tools are usually better. Each call " +
      "starts a fresh shell, so cd and variables do not carry over: chain commands with && instead. There is " +
      "no stdin, so anything interactive gets end-of-file; use non-interactive flags. To leave a server " +
      "running, start it in the background with its output redirected to a file.",
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

  async run(input, { cwd, signal, versions }) {
    const { command, timeout = DEFAULT_TIMEOUT } = input as { command: string; timeout?: number };
    const seconds = Math.min(Math.max(timeout, 1), MAX_TIMEOUT);
    const output = await runCommand(command, cwd, seconds, signal);
    await recordViewedFiles(command, cwd, versions);
    return output;
  },
};

// Programs that print a file's content. Models often look at files this way instead of with read_file.
const VIEWERS = new Set(["cat", "head", "tail", "nl"]);

/**
 * A file the model printed with `cat` (or head, tail) counts as read for edit_file's read-before-edit
 * check. The benchmark showed why: without this, edits after a `cat` were refused and had to be redone.
 */
async function recordViewedFiles(command: string, cwd: string, versions: FileVersions): Promise<void> {
  for (const [program, ...args] of parseCommand(command) ?? []) {
    if (!VIEWERS.has(program)) continue;
    for (const arg of args) {
      const abs = resolve(cwd, arg);
      if (arg.startsWith("-") || !isInside(cwd, abs)) continue;
      const info = await stat(abs).catch(() => null);
      if (info?.isFile()) await versions.record(abs, info);
    }
  }
}

export function runCommand(command: string, cwd: string, seconds: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // detached puts the command in its own process group, so a timeout or Ctrl+C can kill it together
    // with everything it started (a test runner and its workers, say), not just the shell.
    const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let killedBecause = "";
    const kill = (reason: string) => {
      killedBecause ||= reason;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // the process group has already exited
      }
    };
    const collect = (chunk: string) => {
      output += chunk;
      if (output.length > MAX_CAPTURE) kill(`it printed more than ${MAX_CAPTURE} characters`);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);

    const timer = setTimeout(() => kill(`it timed out after ${seconds}s`), seconds * 1000);
    const onAbort = () => kill("the user interrupted it");
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanUp = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanUp();
      reject(err);
    });
    // "close" waits for the output pipes to close, so a background process that keeps them open holds
    // the call until the timeout. That is why the description says to redirect a server's output.
    child.on("close", (code, killSignal) => {
      cleanUp();
      const status = killedBecause ? `Killed: ${killedBecause}.` : `Exit code: ${code ?? killSignal}`;
      resolve(`${output.trimEnd() || "(no output)"}\n\n${status}`);
    });
  });
}
