import { execFile, spawn } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, writeFileSync } from "node:fs";
import { type FileHandle, mkdir, open, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createLog, type Log } from "../log.ts";
import { checkDisk, DiskLimit, type JigEvent, jigArgs, keyVariable, type Leftover, type RunExit, type RunHandle, type Runner, taskFolders, taskToken, watchDisk, workspaceProblem } from "../runner.ts";
import type { Task, Tenant, Workspace } from "../store.ts";

// Runs each task's jig as a process on this machine, in a folder of its own under the data directory:
// work/ is the project jig works in, home/ its HOME and JIG_HOME, home/tmp its TMPDIR, and beside them the
// events and stats files jig writes, outside the project. jig's sandbox lets its commands read the whole
// machine and write the temp folders, so the runner gives each jig settings that hide the data directory from
// them, all but the task's own project and home (see tools/util.ts's keptIn), and what `hidden` lists (the
// database, the config's folder): another task's folder, the events and stats files and the database are
// out of their reach, in a temp folder too. jig keeps long outputs, and --keep-inputs' copies, in $TMPDIR, so
// that is the task's own: in a shared one, other tasks' commands could read them, and write them. With
// `isolation` (the config's local.isolation "service", the default on Linux) the settings ask jig for
// isolation too: its commands then get a /tmp, /var/tmp, /run and IPC of the task's own (see src/sandbox.ts's
// createSandbox), where without it they share the machine's /tmp and /var/tmp by their paths and every Unix
// socket on it. What they share either way is the machine: its kernel, the Unix sockets outside those
// folders, the rest of what the service's user can read, and on macOS its processes and localhost. jig runs
// with --sandbox, so one that can't make its sandbox fails, rather than run the task's commands directly on
// the machine, unless the config turns that off (sandbox: false, local.allowUnsandboxed).

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
  /** Whether a clone follows a redirect on its first request, as git does by default (default: no, as with gitHosts). */
  gitRedirects?: boolean;
  /** The service's internal listener, where a task with approvals asks for them. */
  internalBaseUrl?: string;
  /** How often the events file is read, in milliseconds. */
  pollMs?: number;
  /** What else tasks' commands can't read, beside dataDir: the database's files and the config's folder, say. */
  hidden?: string[];
  /** The most bytes a task's folder may take on the disk before its run is stopped (runner.ts's watchDisk); 0 or none: no cap. */
  maxDiskBytes?: number;
  /** How often the folder is measured, in milliseconds (default 5000). */
  diskPollMs?: number;
  /** Run jig with --sandbox, so a task whose jig can't make one fails (default: yes). */
  sandbox?: boolean;
  /** Give each task's commands their own /tmp, /var/tmp, /run and IPC: jig's isolation "service" (default: no). */
  isolation?: boolean;
  /** Where the runner's lines go (default: the service's log). */
  log?: Log;
}

/**
 * A run's process, in its folder's run.json, for the service that comes after a crash: its pid and host and,
 * on Linux, the boot and the process's start time, which tell it from another that has the pid since.
 */
interface RunFile {
  pid: number;
  host: string;
  bootId?: string;
  starttime?: number;
}

// The service's environment holds its own secrets (and maybe real provider keys): jig gets only these of it.
// Not its TMPDIR: each task has its own.
const PASSED = ["PATH", "LANG", "LC_ALL", "TZ"];
// After SIGTERM, how long jig has to stop its commands before the whole process group is killed.
export const TERM_MS = 5_000;

export class LocalRunner implements Runner {
  private config: LocalRunnerConfig;
  private log: Log;

  constructor(config: LocalRunnerConfig) {
    this.config = config;
    this.log = config.log ?? createLog("service");
  }

  /** The task's folder. */
  dir(id: string): string {
    return join(this.config.dataDir, "tasks", id);
  }

  async removeFiles(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  leftovers(): Promise<Leftover[]> {
    return taskFolders(this.config.dataDir);
  }

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    const { graceSeconds, pollMs = 100, maxDiskBytes = 0 } = this.config;
    const dir = this.dir(task.id);
    const work = join(dir, "work");
    const home = join(dir, "home");
    await rm(dir, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await mkdir(join(home, ".jig"), { recursive: true });
    await mkdir(join(home, "tmp"));
    const hiddenPaths = [resolve(this.config.dataDir), ...(this.config.hidden ?? []).map((path) => resolve(path))];
    const settings = { hiddenPaths, ...(this.config.isolation && { isolation: "service" }) };
    await writeFile(join(home, ".jig", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

    // The disk cap: the folder is measured from here on, through a clone too, and the run stopped past it.
    // Until jig runs, what is stopped is the clone.
    let overDisk: string | undefined;
    const preparing = new AbortController();
    let stopRun = () => preparing.abort();
    const over = (why: string) => {
      overDisk ??= why;
      this.log.warn("stopping a task whose folder went past the disk cap", { tenant: tenant.id, task: task.id, why });
      stopRun();
    };
    const unwatch = maxDiskBytes ? watchDisk(dir, maxDiskBytes, over, this.config.diskPollMs, { log: this.log }) : () => {};
    // Whatever throws from here on, the watch ends with the start.
    try {
      await prepareWorkspace(work, task.spec.workspace, this.config.gitProtocols ?? ["https"], this.log.with({ tenant: tenant.id, task: task.id }), this.config.gitRedirects, preparing.signal);
      // A workspace past the cap by itself never starts its jig.
      await checkDisk(dir, maxDiskBytes);

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
      const [program, ...first] = this.config.jig;
      const sandbox = (this.config.sandbox ?? true) ? ["--sandbox"] : [];
      const args = [...first, ...sandbox, ...jigArgs(task, tenant, { cwd: work, events, stats, baseUrl: this.config.gatewayBaseUrl, internalBaseUrl: this.config.internalBaseUrl })];
      const out = openSync(log, "w");
      // A process group of its own, so a cancel or the time limit reaches what jig started too.
      const child = spawn(program, args, { cwd: work, env, detached: true, stdio: ["pipe", out, out] });
      closeSync(out);
      // At once, before jig can have exited and its pid gone to another process.
      if (child.pid) this.record(join(dir, "run.json"), child.pid);
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
      // From now the cap stops jig, at once if the folder went past it since the check.
      stopRun = stop;
      if (overDisk) stop();
      const deadline = setTimeout(() => ((timedOut = true), stop()), (timeLimit + graceSeconds) * 1000);
      const exit = new Promise<RunExit>((done) => {
        child.on("error", (err) => {
          exited = true;
          clearTimeout(deadline);
          unwatch();
          done({ exitCode: null, timedOut, overDisk, message: `jig didn't start: ${err.message}` });
        });
        child.on("exit", (code) => {
          exited = true;
          clearTimeout(deadline);
          clearTimeout(killer);
          unwatch();
          // Whatever jig left in its group (a job in the background, say) ends with it.
          killGroup("SIGKILL");
          done({ exitCode: code, timedOut, overDisk });
        });
      }).then(async (result) => ({
        ...result,
        stats: await readStats(stats),
        message: result.message ?? (result.exitCode === 0 ? undefined : await lastLine(log)),
      }));
      return { events: tail(events, () => exited, pollMs), wait: () => exit, cancel: stop };
    } catch (err) {
      unwatch();
      // A clone the cap stopped fails as a clone: the task is told of the cap.
      throw overDisk ? new DiskLimit(overDisk) : err;
    }
  }

  /**
   * Writes run.json, for abandon. A run whose file can't be written goes on all the same: it just can't be
   * stopped after a crash.
   */
  private record(file: string, pid: number): void {
    const run: RunFile = { pid, host: hostname() };
    if (process.platform === "linux") Object.assign(run, { bootId: bootId(), starttime: startTime(pid) });
    try {
      writeFileSync(file, `${JSON.stringify(run)}\n`);
    } catch (err) {
      this.log.warn("couldn't write the run's run.json", { err });
    }
  }

  /**
   * Stops the jig a gone service (this one, before a crash) left running for the task, which is detached and
   * would spend until its time limit: SIGTERM to its process group, then SIGKILL after TERM_MS. Only on Linux,
   * and only if run.json names this machine, this boot and a process that started when the run's did: the
   * pid may be another's by now. Anything else, a missing file included, is nothing to stop.
   */
  async abandon(id: string): Promise<void> {
    // Read as the stats file is: a regular file, or nothing.
    const run = (await readStats(join(this.dir(id), "run.json"))) as Partial<RunFile> | null | undefined;
    if (process.platform !== "linux" || !run || run.host !== hostname() || run.bootId === undefined || run.bootId !== bootId()) return;
    const { pid } = run;
    // 0 and 1 as a group would be the service's own and every process.
    if (!Number.isInteger(pid) || pid! <= 1 || run.starttime === undefined || startTime(pid!) !== run.starttime) return;
    const signal = (name: NodeJS.Signals | 0) => {
      try {
        process.kill(-pid!, name);
        return true;
      } catch {
        return false; // the group is gone
      }
    };
    this.log.warn("stopping the jig a gone service left running", { task: id, pid });
    if (!signal("SIGTERM")) return;
    const deadline = Date.now() + TERM_MS;
    while (signal(0)) {
      if (Date.now() >= deadline) return void signal("SIGKILL");
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

/** This boot of the machine's id, on Linux. */
function bootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

/** When the process started, in clock ticks since the boot (field 22 of /proc/<pid>/stat), on Linux. */
function startTime(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The fields after the command's name, which is in parentheses and may hold spaces and parentheses itself.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = Number(fields[22 - 3]);
    return Number.isInteger(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes a task's files into its (empty) workspace, or clones its repository there. What git says of a
 * clone that fails goes to `log`; the task is told only that it failed, or that a redirect it was sent isn't
 * followed. With `redirects`, a redirect on the clone's first request is followed, as git does by default;
 * without, none is. `signal` stops a clone under way, which then fails.
 */
export async function prepareWorkspace(work: string, workspace: Workspace | undefined, protocols: string[], log?: Log, redirects = false, signal?: AbortSignal): Promise<void> {
  for (const [path, contents] of Object.entries(workspace?.files ?? {})) {
    const problem = workspaceProblem(path);
    if (problem) throw new Error(`The workspace file ${JSON.stringify(path)} ${problem}.`);
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), contents, { flag: "wx" });
  }
  if (!workspace?.git) return;
  // Shallow, with no hooks or templates (whose hooks a clone would run) and only the protocols allowed: git
  // runs a program for some others (ext::). With gitHosts, no redirect is followed: the tenant's URL, checked
  // against them, is the only host asked. Without, any host may be named, so a redirect gets round nothing.
  const args = ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...(redirects ? [] : ["-c", "http.followRedirects=false"]), "clone", "--quiet", "--depth", "1", "--no-tags", ...(workspace.ref ? ["--branch", workspace.ref] : []), "--", workspace.git, work];
  const env = { PATH: process.env.PATH, HOME: dirname(work), GIT_ALLOW_PROTOCOL: protocols.join(":"), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  await promisify(execFile)("git", args, { env, timeout: 120_000, signal }).catch((err: { code?: unknown; signal?: string | null; stderr?: string; message: string }) => {
    // git names the hosts and ports it tried and how they answered: told to the tenant, a clone on the
    // service's network would scan it for them.
    log?.warn("git clone failed", { stderr: (err.stderr || err.message).trim() });
    // That much is the tenant's to know, to give the URL the host redirects to: not where it redirects.
    if (!redirects && /The requested URL returned error: 30[12378]\b/.test(err.stderr ?? "")) {
      throw new Error("git clone failed: the git host answered with a redirect, which isn't followed; give the repository's URL as the host has it (with .git at its end, say)");
    }
    throw new Error(`git clone failed (${typeof err.code === "number" ? `exit ${err.code}` : (err.signal ?? err.code ?? "no exit code")})`);
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

/** The most a seq can be: what a Postgres integer (and so both stores) can hold. */
const MAX_SEQ = 2 ** 31 - 1;

/**
 * The event a line holds, or undefined if it isn't one. A seq past MAX_SEQ isn't one: a run's commands may
 * write its events, and that one could never be stored.
 */
export function parseEvent(line: string): JigEvent | undefined {
  try {
    const event = JSON.parse(line);
    return event && Number.isInteger(event.seq) && event.seq > 0 && event.seq <= MAX_SEQ && typeof event.type === "string" ? event : undefined;
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
