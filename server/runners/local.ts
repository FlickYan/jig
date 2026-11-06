import { execFile, spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { type FileHandle, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type JigEvent, jigArgs, keyVariable, type RunExit, type RunHandle, type Runner, taskToken, workspaceProblem } from "../runner.ts";
import type { Task, Tenant, Workspace } from "../store.ts";

// Runs each task's jig as a process on this machine, in a folder of its own under the data directory:
// work/ is the project jig works in, home/ its HOME and JIG_HOME, home/tmp its TMPDIR, and beside them the
// events and stats files jig writes, outside the project. jig's sandbox lets its commands read the whole
// machine and write the temp folders, so the runner gives each jig settings that hide the data directory from
// them, all but the task's own project and home (see tools/util.ts's keptIn), and the database and the
// service's config: another task's folder, the events and stats files and the database are out of their
// reach, in a temp folder too. jig keeps long outputs, and --keep-inputs' copies, in $TMPDIR, so that is the
// task's own: in a shared one, other tasks' commands could read them, and write them. What they still share is
// the machine: its kernel, /tmp and /var/tmp by their paths, and on macOS its processes and localhost.
// Without a sandbox (sandboxProblem), commands run directly on it.

export interface LocalRunnerConfig {
  dataDir: string;
  /** How to start jig: a program and its first arguments. */
  jig: string[];
  /** The gateway's Anthropic-compatible base URL, which jig gets as --base-url. */
  gatewayBaseUrl: string;
  /** The secret the gateway checks tokens with (JIG_GATEWAY_SECRET). */
  gatewaySecret: string;
  /** Seconds past the task's time limit before the runner stops a jig that hasn't stopped itself. */
  graceSeconds: number;
  /** The protocols a git workspace may be cloned over (default: https only). */
  gitProtocols?: string[];
  /** The service's internal listener, where a task with approvals asks for them. */
  internalBaseUrl?: string;
  /** How often the events file is read, in milliseconds. */
  pollMs?: number;
  /** What else tasks' commands can't read, beside dataDir: the database's files and the service's config. */
  hidden?: string[];
}

// The service's environment holds its own secrets (and maybe real provider keys): jig gets only these of it.
// Not its TMPDIR: each task has its own.
const PASSED = ["PATH", "LANG", "LC_ALL", "TZ"];
// After SIGTERM, how long jig has to stop its commands before the whole process group is killed.
export const TERM_MS = 5_000;

export class LocalRunner implements Runner {
  private config: LocalRunnerConfig;

  constructor(config: LocalRunnerConfig) {
    this.config = config;
  }

  /** The task's folder. */
  dir(id: string): string {
    return join(this.config.dataDir, "tasks", id);
  }

  async removeFiles(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    const { graceSeconds, pollMs = 100 } = this.config;
    const dir = this.dir(task.id);
    const work = join(dir, "work");
    const home = join(dir, "home");
    await rm(dir, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await mkdir(join(home, ".jig"), { recursive: true });
    await mkdir(join(home, "tmp"));
    const hiddenPaths = [resolve(this.config.dataDir), ...(this.config.hidden ?? []).map((path) => resolve(path))];
    await writeFile(join(home, ".jig", "settings.json"), `${JSON.stringify({ hiddenPaths }, null, 2)}\n`);
    await prepareWorkspace(work, task.spec.workspace, this.config.gitProtocols ?? ["https"]);

    const timeLimit = task.spec.timeLimit;
    const token = taskToken(this.config.gatewaySecret, task, tenant, graceSeconds);
    // git, jig's and its commands', looks for a repository no further up than the task's folder: a workspace
    // with none would otherwise take one dataDir lies in (the service run from a checkout) for its own, and
    // jig's sandbox lets commands write the repository it finds.
    const env: NodeJS.ProcessEnv = { HOME: home, JIG_HOME: join(home, ".jig"), TMPDIR: join(home, "tmp"), GIT_CEILING_DIRECTORIES: resolve(dir), NO_COLOR: "1", [keyVariable(task.spec.model)]: token };
    for (const name of PASSED) if (process.env[name] !== undefined) env[name] = process.env[name];

    const events = join(dir, "events.jsonl");
    const stats = join(dir, "stats.json");
    const log = join(dir, "output.log");
    const out = openSync(log, "w");
    const [program, ...first] = this.config.jig;
    // A process group of its own, so a cancel or the time limit reaches what jig started too.
    const child = spawn(program, [...first, ...jigArgs(task, tenant, { cwd: work, events, stats, baseUrl: this.config.gatewayBaseUrl, internalBaseUrl: this.config.internalBaseUrl })], { cwd: work, env, detached: true, stdio: ["pipe", out, out] });
    closeSync(out);
    child.stdin!.on("error", () => {}); // a jig that exits before reading its task
    child.stdin!.end(task.spec.prompt);

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {} // the group is gone
    };
    let exited = false;
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (exited) return;
      killGroup("SIGTERM");
      killer ??= setTimeout(() => killGroup("SIGKILL"), TERM_MS);
    };
    const deadline = setTimeout(() => ((timedOut = true), stop()), (timeLimit + graceSeconds) * 1000);
    const exit = new Promise<RunExit>((done) => {
      child.on("error", (err) => {
        exited = true;
        clearTimeout(deadline);
        done({ exitCode: null, timedOut, message: `jig didn't start: ${err.message}` });
      });
      child.on("exit", (code) => {
        exited = true;
        clearTimeout(deadline);
        clearTimeout(killer);
        // Whatever jig left in its group (a job in the background, say) ends with it.
        killGroup("SIGKILL");
        done({ exitCode: code, timedOut });
      });
    }).then(async (result) => ({
      ...result,
      stats: await readStats(stats),
      message: result.message ?? (result.exitCode === 0 ? undefined : await lastLine(log)),
    }));
    return { events: tail(events, () => exited, pollMs), wait: () => exit, cancel: stop };
  }
}

/** Writes a task's files into its (empty) workspace, or clones its repository there. */
export async function prepareWorkspace(work: string, workspace: Workspace | undefined, protocols: string[]): Promise<void> {
  for (const [path, contents] of Object.entries(workspace?.files ?? {})) {
    const problem = workspaceProblem(path);
    if (problem) throw new Error(`The workspace file ${JSON.stringify(path)} ${problem}.`);
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), contents, { flag: "wx" });
  }
  if (!workspace?.git) return;
  // Shallow, with no hooks or templates (whose hooks a clone would run) and only the protocols allowed: git
  // runs a program for some others (ext::).
  const args = ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "clone", "--quiet", "--depth", "1", "--no-tags", ...(workspace.ref ? ["--branch", workspace.ref] : []), "--", workspace.git, work];
  const env = { PATH: process.env.PATH, HOME: dirname(work), GIT_ALLOW_PROTOCOL: protocols.join(":"), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  await promisify(execFile)("git", args, { env, timeout: 120_000 }).catch((err: { stderr?: string; message: string }) => {
    throw new Error(`git clone failed: ${(err.stderr || err.message).trim()}`);
  });
}

/** The longest line of a run's events that is read, in bytes: jig's are far shorter. */
export const MAX_LINE = 1024 * 1024;

/**
 * Cuts bytes into lines, leaving out any line longer than MAX_LINE without holding it: in a container a
 * task's commands can write the events (or the log) too, and a line with no end would otherwise grow in
 * the service's memory until it ran out.
 */
export class Lines {
  private parts: Buffer[] = [];
  private size = 0;
  /** In a line too long to keep, until its newline. */
  private skipping = false;

  /** The lines the chunk ends. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    // A newline byte is never part of another character in UTF-8, so the bytes can be cut at it.
    for (let end; (end = chunk.indexOf(10, start)) !== -1; start = end + 1) {
      if (!this.skipping && this.size + end - start <= MAX_LINE) lines.push(Buffer.concat([...this.parts, chunk.subarray(start, end)]).toString("utf8"));
      this.parts = [];
      this.size = 0;
      this.skipping = false;
    }
    const rest = chunk.subarray(start);
    if (this.skipping || !rest.length) return lines;
    if (this.size + rest.length > MAX_LINE) {
      this.parts = [];
      this.size = 0;
      this.skipping = true;
    } else {
      // A copy, as the caller may read into the same buffer again.
      this.parts.push(Buffer.from(rest));
      this.size += rest.length;
    }
    return lines;
  }

  /** What is left after the last newline, if it isn't too long. */
  end(): string | undefined {
    const rest = this.skipping || !this.size ? undefined : Buffer.concat(this.parts).toString("utf8");
    this.parts = [];
    this.size = 0;
    this.skipping = false;
    return rest;
  }
}

/**
 * The events jig appends to `file`, as it writes them, until `finished()` and the last of them is read. A
 * line that isn't an event, one over MAX_LINE, or a last one cut short by a crash is left out.
 */
export async function* tail(file: string, finished: () => boolean, pollMs: number): AsyncGenerator<JigEvent> {
  const lines = new Lines();
  const chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  for (;;) {
    // Looked at before the read, so the read after jig's exit gets all it wrote.
    const last = finished();
    const handle = await openRegular(file);
    if (handle) {
      try {
        // A chunk at a time, its events passed on before the next is read.
        for (let read; (read = (await handle.read(chunk, 0, chunk.length, offset)).bytesRead) > 0; offset += read) {
          for (const line of lines.push(chunk.subarray(0, read))) {
            const event = parseEvent(line);
            if (event) yield event;
          }
        }
      } finally {
        await handle.close();
      }
    }
    if (last) return;
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

/** The event a line holds, or undefined if it isn't one. */
export function parseEvent(line: string): JigEvent | undefined {
  try {
    const event = JSON.parse(line);
    return event && Number.isInteger(event.seq) && event.seq > 0 && typeof event.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

/** The last line of what jig printed (of its last 4 KB), cut to 500 characters. */
export async function lastLine(log: string): Promise<string | undefined> {
  const handle = await openRegular(log);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, Math.max(0, size - 4096));
    return buffer.subarray(0, bytesRead).toString("utf8").trim().split("\n").at(-1)?.slice(-500) || undefined;
  } finally {
    await handle.close();
  }
}

/**
 * A file the run wrote, opened for reading only if it is a regular file there: a command that could write
 * the task's folder (in a container, where jig runs without its sandbox) could leave a link to a file of
 * the service's in its place, or a named pipe that would hold the read up for good.
 */
export async function openRegular(path: string): Promise<FileHandle | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (handle && !(await handle.stat()).isFile()) {
    await handle.close();
    return undefined;
  }
  return handle;
}

/** jig's --stats file, if it left one. */
export async function readStats(path: string): Promise<unknown> {
  const handle = await openRegular(path);
  try {
    return handle && JSON.parse(await handle.readFile("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
