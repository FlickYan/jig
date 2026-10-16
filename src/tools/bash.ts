// bash: runs a command in a fresh shell, in the sandbox when there is one and in a process group of its
// own, so a timeout or Ctrl+C stops everything it started; jig's API keys are kept out of its environment.
// The model gets the output and the exit code; a job left in the background keeps running, as in a terminal.
// A long output is cut from the middle, and the whole of it goes to a file the model can search.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, openSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Sandbox } from "../sandbox.ts";
import type { Tool, ToolContext } from "./index.ts";
import { parseCommand } from "./shell.ts";
import { type FileVersions, isInside, withoutKeys } from "./util.ts";

const DEFAULT_TIMEOUT = 120; // seconds
const MAX_TIMEOUT = 600;
// Characters of output the model sees: all of it, or the first and last half of this. It leaves room for
// the notes and the exit code within the loop's own cut (MAX_OUTPUT_CHARS, 40,000), which keeps a result's
// head and tail too, but doesn't know where the whole output is.
const SHOWN = 39_000;
const MAX_SAVED = 100_000_000; // characters of output kept in files, in all
export const LINGER_MS = 1000; // how long to wait, once the shell has exited, for a background job's last output
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

  async run(input, { cwd, signal, versions, sandbox, dirs = [], outputs, count }) {
    const { command, timeout = DEFAULT_TIMEOUT } = input as { command: string; timeout?: number };
    const seconds = Math.min(Math.max(timeout, 1), MAX_TIMEOUT);
    const output = await runCommand(command, cwd, seconds, signal, sandbox, outputs, count);
    await recordViewedFiles(command, cwd, versions, dirs);
    return output;
  },
};

// Programs that print a file's content. Models often look at files this way instead of with read_file.
const VIEWERS = new Set(["cat", "head", "tail", "nl"]);

/**
 * A file the model printed with `cat` (or head, tail, nl) counts as read, for write_file's check that a
 * file it overwrites was read as it is. The benchmark showed why: without this, changes after a `cat`
 * were refused and had to be redone.
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

/**
 * Why a task's signal stopped something, for its result: the words the task was stopped with (the CLI's, at
 * --time-limit), or else `byUser`, since Ctrl+C gives none.
 */
export function whyStopped(signal: AbortSignal | undefined, byUser: string): string {
  return typeof signal?.reason === "string" ? signal.reason : byUser;
}

/**
 * Runs a command; resolves to its output (its head and tail, if it is long) and how it ended, and rejects
 * only if it can't be started. Given `files`, the whole of a long output is kept in one of them, and given
 * `count`, cutting it counts as the loop's own cut does (the loop's then has nothing left to cut).
 */
export function runCommand(
  command: string,
  cwd: string,
  seconds: number,
  signal?: AbortSignal,
  sandbox?: Sandbox,
  files?: OutputFiles,
  count?: ToolContext["count"],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { program, args } = sandbox?.wrap(command) ?? { program: "bash", args: ["-c", command] };
    // detached puts the command in its own process group, so a timeout or Ctrl+C can kill it together
    // with everything it started (a test runner and its workers, say), not just the shell.
    const child = spawn(program, args, { cwd, env: withoutKeys(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = new Output(files);
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
      output.add(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);

    const timer = setTimeout(() => kill(`it timed out after ${seconds}s`), seconds * 1000);
    const onAbort = () => kill(whyStopped(signal, "the user interrupted it"));
    signal?.addEventListener("abort", onAbort, { once: true });
    let lingering: NodeJS.Timeout | undefined;
    const settle = () => {
      done = true;
      output.close();
      clearTimeout(timer);
      clearTimeout(lingering);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (status: string, note = "") => {
      if (done) return;
      settle();
      if (output.cut) count?.("output.truncated");
      resolve(`${output.shown().trimEnd() || "(no output)"}\n\n${note ? `${note}\n` : ""}${status}`);
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

/**
 * A command's output, as much of it as the model sees: all of it up to SHOWN characters, or else the first
 * and last SHOWN / 2, with the whole of it in a file when there are files to keep it in. Memory stays the
 * same however much a command prints, so a command that prints a lot runs to the end; it used to be killed
 * at 5 million characters, its exit code lost.
 */
class Output {
  private head = "";
  private tail = "";
  private length = 0;
  private file?: OutputFile;
  private readonly files?: OutputFiles;

  constructor(files?: OutputFiles) {
    this.files = files;
  }

  add(chunk: string): void {
    // Once there is more than the model will see, everything so far and all that follows goes to a file.
    if (this.length <= SHOWN && this.length + chunk.length > SHOWN) this.file = this.files?.create(this.head + this.tail);
    if (this.file) this.files!.add(this.file, chunk);
    this.length += chunk.length;
    const room = SHOWN / 2 - this.head.length;
    if (room > 0) {
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    this.tail = (this.tail + chunk).slice(-SHOWN / 2);
  }

  /** Whether there is more than the model will see, so only the head and tail are shown. */
  get cut(): boolean {
    return this.length > SHOWN;
  }

  /** The command has ended: nothing more goes to its file. */
  close(): void {
    if (this.file) this.files!.close(this.file);
  }

  /** The output, or its head and tail with where the rest is. */
  shown(): string {
    if (this.length <= SHOWN) return this.head + this.tail;
    const file = this.file;
    const where = !file
      ? ""
      : `. ${file.whole ? "The whole output is" : `The output's first ${file.size} characters are`} in ${file.path}: ` +
        "search it with grep -n, or print lines of it with sed -n, rather than running the command again";
    return `${this.head}\n\n[... ${this.length - SHOWN} characters truncated${where} ...]\n\n${this.tail}`;
  }
}

/** A file holding a command's output: all of it, or its first `size` characters. */
interface OutputFile {
  path: string;
  fd: number;
  size: number;
  whole: boolean;
}

/**
 * Where the whole of a long output goes, so the model can search it instead of running the command again:
 * files in the temp directory, which commands can read, sandboxed or not, and other users can't. They hold
 * `limit` characters in all, the oldest making room for new ones, and jig removes them when it exits.
 *
 * Each file is made new, with a name of its own, right in the temp directory, and written only through
 * the descriptor that made it: sandboxed commands can write in the temp directory, and given a directory of
 * jig's there, or a path jig opens again, one could swap in a symlink and have jig write outside the sandbox.
 */
export class OutputFiles {
  private files: OutputFile[] = []; // oldest first
  private size = 0;
  private readonly limit: number;

  constructor(limit = MAX_SAVED) {
    this.limit = limit;
  }

  /** A new file, holding `text` to begin with; undefined if it can't be made. */
  create(text: string): OutputFile | undefined {
    try {
      const path = join(tmpdir(), `jig-output-${randomBytes(6).toString("hex")}.log`);
      const file = { path, fd: openSync(path, "ax", 0o600), size: 0, whole: true };
      this.files.push(file);
      this.add(file, text);
      return file;
    } catch {
      return undefined;
    }
  }

  /** Adds to a file, as far as the limit lets it. Once something is left out, nothing more is added. */
  add(file: OutputFile, text: string): void {
    if (!file.whole) return;
    try {
      // The newest output is the one the model is likely to want.
      while (this.size + text.length > this.limit && this.files[0] !== file) {
        const old = this.files.shift()!;
        this.size -= old.size;
        deleteFile(old.path);
      }
      const part = text.slice(0, this.limit - this.size);
      appendFileSync(file.fd, part);
      file.size += part.length;
      this.size += part.length;
      file.whole = part.length === text.length;
    } catch {
      file.whole = false;
    }
  }

  /** Done with a file: its command has ended. */
  close(file: OutputFile): void {
    try {
      closeSync(file.fd);
    } catch {
      // already closed
    }
  }

  /** Deletes the files. */
  remove(): void {
    for (const file of this.files) deleteFile(file.path);
    this.files = [];
    this.size = 0;
  }
}

/** Deletes a file, or a symlink in its place, but not something else a command has put there. */
function deleteFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // a directory, say: the temp directory is the commands' too
  }
}

/** bash without jig's search and read tools beside it (--tools): its description doesn't point at them. */
export const bashOnItsOwn: Tool = { ...bashTool, definition: { ...bashTool.definition, description: `${ABOUT} ${RULES}` } };
