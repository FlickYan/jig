import { spawn } from "node:child_process";
import type { Tool } from "./index.ts";

const DEFAULT_TIMEOUT = 120; // seconds
const MAX_TIMEOUT = 600;
const MAX_CAPTURE = 5_000_000; // characters; a command printing more than this is killed

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description:
      "Run a shell command with bash in the working directory. Returns stdout and stderr combined, then the " +
      "exit code. Use it to run tests, builds and git, and to explore the project (ls, rg, find). Each call " +
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
  readOnly: false,
  describe: ({ command }) => String(command),

  run(input, { cwd, signal }) {
    const { command, timeout = DEFAULT_TIMEOUT } = input as { command: string; timeout?: number };
    const seconds = Math.min(Math.max(timeout, 1), MAX_TIMEOUT);
    return runCommand(command, cwd, seconds, signal);
  },
};

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
