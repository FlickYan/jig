import { createHmac } from "node:crypto";
import { lstat, opendir, readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { createLog, type Log } from "./log.ts";
import type { Task, TaskStatus, Tenant } from "./store.ts";

// What runs a task: the interface every runner keeps (runners/local.ts, docker.ts and k8s.ts),
// and what they share: jig's command line, the task's gateway token, and how jig's exit becomes a status.

/** One line of jig's --events file (the event contract, v1). Readers ignore types they don't know. */
export interface JigEvent {
  v: number;
  seq: number;
  ts: string;
  type: string;
  [field: string]: unknown;
}

export interface RunExit {
  /** jig's exit code, or null if a signal ended it. */
  exitCode: number | null;
  /** The runner stopped it at the task's time limit and grace, as jig didn't stop itself. */
  timedOut: boolean;
  /** jig's --stats file, if it left one. */
  stats?: unknown;
  /** Why it failed, where jig said so (the last line it printed). */
  message?: string;
  /** The runner stopped it because its folder went past the disk cap, or couldn't be measured: what the task is told. */
  overDisk?: string;
}

export interface RunHandle {
  /** The run's events as jig writes them; ends after the run does, with the last of them. */
  events: AsyncIterable<JigEvent>;
  wait(): Promise<RunExit>;
  /** Stops the run and everything it started. */
  cancel(): void;
  /** It runs on a worker started ahead of it (pool.ts), rather than one started for it. */
  warm?: boolean;
}

export interface Runner {
  start(task: Task, tenant: Tenant): Promise<RunHandle>;
  /** The workers it keeps warm, if it keeps any: how many wait for a task. */
  readonly pool?: { stats(): { idle: number } };
  /** Removes what a task's run left on this machine (its folder), once the run has ended. */
  removeFiles?(id: string): Promise<void>;
  /** The task folders on this machine (taskFolders), run by any replica that shares it. */
  leftovers?(): Promise<Leftover[]>;
  /**
   * Stops what may still run of a task whose replica is gone (its container or Job), as far as this
   * replica can reach it: the task has ended as an error, and the run would spend until its deadline.
   */
  abandon?(id: string): Promise<void>;
  /** Starts the workers it keeps warm (pool.ts), which claim their tasks at the internal listener, as they reach it. */
  warm?(internalBaseUrl: string): void;
  /** Answers a warm worker's claim, POST /internal/pool/claim on the internal listener. */
  claim?(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Stops the workers it keeps warm, and settles once they are gone: the service is shutting down. */
  close?(): Promise<void>;
}

/** A task's id (store.ts's newTaskId), with its region or without: a warm worker's pool_<hex> folder isn't one. */
const TASK_ID = /^task_(?:[a-z0-9]{1,16}_)?[0-9a-f]{32}$/;

/** A task's folder on this machine, and when it last changed. */
export interface Leftover {
  id: string;
  /** The latest mtime of the folder and of what is directly in it (a run's events.jsonl and output.log), in ms. */
  changed: number;
}

/** The task folders under dataDir/tasks, none if it has none yet. */
export async function taskFolders(dataDir: string): Promise<Leftover[]> {
  const tasks = join(dataDir, "tasks");
  const names = await readdir(tasks).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const folders = await Promise.all(
    names
      .filter((name) => TASK_ID.test(name))
      .map(async (id) => {
        const folder = join(tasks, id);
        const paths = [folder, ...(await readdir(folder).catch(() => [])).map((name) => join(folder, name))];
        // A folder removed meanwhile is left out; a file that is counts for nothing.
        const times = await Promise.all(paths.map((path) => stat(path).then((stats) => stats.mtimeMs, () => undefined)));
        return times[0] === undefined ? undefined : { id, changed: Math.max(...times.filter((time) => time !== undefined)) };
      }),
  );
  return folders.filter((folder) => folder !== undefined);
}

// The disk cap (docs/server.md): the local and Docker runners keep each task's folder on this machine's
// disk, which has no quota for it, so they measure the folder while the task runs and stop a run whose
// folder went past maxTaskDiskBytes. A check, not a quota: a task can overshoot by what it writes between
// two checks.

/** The task's folder went away while it was measured: its run has ended, and there is nothing to hold. */
export class Gone extends Error {}

/** The folder can't be measured, so it can't be held to a cap: `code` is the error's, or "too many" (entries). */
export class Unmeasurable extends Error {
  code: string;
  constructor(code: string) {
    super(`the folder can't be measured (${code})`);
    this.code = code;
  }
}

/** The most entries a walk reads: past it, a task could hold the walks up for as long as it liked. */
export const MAX_ENTRIES = 1_000_000;
// What a task's commands can make of their folder so that it can't be read.
const UNREADABLE = new Set(["EACCES", "EPERM", "ENAMETOOLONG", "ELOOP"]);

/** What the task is told when its folder went past the cap. No byte count: the walk stops at the limit. */
export const diskError = (limit: number) => `the task's folder grew past maxTaskDiskBytes (${limit} bytes), so the service stopped the run`;
export const DISK_UNMEASURABLE = `the task's folder can't be measured (a folder the service can't read, a path too long, or over ${MAX_ENTRIES} files), so it can't be held to maxTaskDiskBytes: the service stopped the run`;

/**
 * The bytes the folder takes on its disk, or some number over `limit` as soon as the sum is over it: the
 * blocks of the folder and of everything in it, so a sparse file counts for what it holds. No link is
 * followed, and no folder on another file system entered (the walk only lstats, and descends by what lstat
 * says): a task's commands could otherwise send it round the machine. A file with several names is
 * counted once. What goes away during the walk is left out; the folder itself gone throws Gone, and one
 * that can't be read through, or holds over `maxEntries` entries, Unmeasurable.
 */
export async function folderBytes(dir: string, limit: number, maxEntries = MAX_ENTRIES): Promise<number> {
  const gone = (err: NodeJS.ErrnoException) => err.code === "ENOENT" || err.code === "ENOTDIR";
  const unreadable = (err: NodeJS.ErrnoException): never => {
    throw UNREADABLE.has(err.code ?? "") ? new Unmeasurable(err.code!) : err;
  };
  const root = await lstat(dir, { bigint: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new Gone(`${dir} is gone`);
    return unreadable(err);
  });
  let sum = Number(root.blocks) * 512;
  let entries = 0;
  /** The files with several names counted so far, by device and inode. */
  const linked = new Map<bigint, Set<bigint>>();
  const folders = [dir];
  for (let folder; sum <= limit && (folder = folders.pop()) !== undefined; ) {
    let handle;
    try {
      handle = await opendir(folder);
    } catch (err) {
      if (!gone(err as NodeJS.ErrnoException)) unreadable(err as NodeJS.ErrnoException);
      if (folder === dir) throw new Gone(`${dir} is gone`);
      continue;
    }
    // The loop closes the folder however it is left.
    for await (const entry of handle) {
      if (++entries > maxEntries) throw new Unmeasurable("too many");
      const path = join(folder, entry.name);
      let stats;
      try {
        stats = await lstat(path, { bigint: true });
      } catch (err) {
        if (gone(err as NodeJS.ErrnoException)) continue;
        return unreadable(err as NodeJS.ErrnoException);
      }
      if (stats.isDirectory()) {
        if (stats.dev === root.dev) folders.push(path);
      } else if (stats.nlink > 1n) {
        const seen = linked.get(stats.dev) ?? linked.set(stats.dev, new Set()).get(stats.dev)!;
        if (seen.has(stats.ino)) continue;
        seen.add(stats.ino);
      }
      sum += Number(stats.blocks) * 512;
      if (sum > limit) break;
    }
  }
  return sum;
}

/**
 * One check of the folder against the cap, before the task's jig starts: throws what the task is told if
 * its workspace alone is past it, or can't be measured. No limit (0), no check.
 */
/** A start the disk cap stopped, before any run: its message is what the task is told, and its stop is disk_limit. */
export class DiskLimit extends Error {}

export async function checkDisk(dir: string, limit: number): Promise<void> {
  if (!limit) return;
  const bytes = await folderBytes(dir, limit).catch((err: unknown) => {
    if (err instanceof Unmeasurable) throw new DiskLimit(DISK_UNMEASURABLE);
    throw err;
  });
  if (bytes > limit) throw new DiskLimit(diskError(limit));
}

/** Every watch's walks, one behind another: a machine full of big trees is read by one walk at a time. */
let walks: Promise<void> = Promise.resolve();

/**
 * Measures the folder while its task runs, and calls `over` once, with what the task is told, when it is
 * past `limit`; then the watch is over. The first walk is `everyMs` after the call, and each next one that
 * long after the last ended, or ten times what the last took if that is longer, so walks take a tenth of the
 * time at most however big the tree. A folder that can't be measured on two walks in a row is over too, as
 * it can't be held to the cap; one walk may only have met a folder as the task made it. A folder that is
 * gone ends the watch. Any other failure is logged once, and the watch goes on. Returns what stops it; a
 * walk then in flight comes to nothing. Its timers don't keep the process going.
 */
export function watchDisk(
  dir: string,
  limit: number,
  over: (why: string) => void,
  everyMs = 5000,
  { log = createLog("service"), measure = folderBytes }: { log?: Log; measure?: (dir: string, limit: number) => Promise<number> } = {},
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let unmeasured = false;
  let warned = false;
  const end = (why?: string) => {
    stopped = true;
    if (why) over(why);
  };
  const walk = async () => {
    if (stopped) return;
    const began = Date.now();
    try {
      const bytes = await measure(dir, limit);
      if (stopped) return;
      unmeasured = false;
      if (bytes > limit) return end(diskError(limit));
    } catch (err) {
      if (stopped) return;
      if (err instanceof Gone) return end();
      if (err instanceof Unmeasurable) {
        if (unmeasured) return end(DISK_UNMEASURABLE);
        unmeasured = true;
      } else if (!warned) {
        warned = true;
        log.warn("couldn't measure a task's folder; the check goes on", { dir, err });
      }
    }
    wait(Math.max(everyMs, 10 * (Date.now() - began)));
  };
  const wait = (ms: number) => {
    // The queue goes on whatever a walk, or what `over` does, throws.
    timer = setTimeout(() => void (walks = walks.then(walk).catch((err: unknown) => log.warn("a check of a task's folder failed", { dir, err }))), ms);
    timer.unref();
  };
  wait(everyMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** A gateway token's payload (the token contract). */
export interface TokenPayload {
  tenant: string;
  task: string;
  /** Unix seconds. */
  exp: number;
  budgetUsd: number | null;
}

/**
 * The credential a task's jig uses as its API key: "jgt1." + base64url(payload) + "." + base64url of the
 * HMAC-SHA256 of what comes before the dot, keyed by the secret the service shares with the gateway.
 */
export function mintToken(secret: string, payload: TokenPayload): string {
  const body = `jgt1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** The token a task's run gets as its key: good until its time limit, the grace and a minute more. */
export function taskToken(secret: string, task: Task, tenant: Tenant, graceSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + task.spec.timeLimit + graceSeconds + 60;
  return mintToken(secret, { tenant: tenant.id, task: task.id, exp, budgetUsd: tenant.limits.budgetUsd });
}

/** The variable jig reads its key from, for a model it runs on the Anthropic API (as src/model.ts does). */
export function keyVariable(model: string): string {
  return model.startsWith("deepseek") ? "DEEPSEEK_API_KEY" : "ANTHROPIC_API_KEY";
}

/**
 * jig's arguments for a task, its prompt to come on stdin (`-`), which keeps it out of the process list. A
 * task with approvals runs in its mode and asks at the service's internal listener (`internalBaseUrl`)
 * before the tool calls that mode doesn't allow; any other runs with --yes.
 */
export function jigArgs(task: Task, tenant: Tenant, paths: { cwd: string; events: string; stats: string; baseUrl: string; internalBaseUrl?: string }): string[] {
  const { model, maxSteps, timeLimit, approvals, mode = "edits" } = task.spec;
  if (approvals && !paths.internalBaseUrl) throw new Error("A task with approvals needs the service's internalBaseUrl, where its jig asks for them");
  const asks = approvals
    ? ["--mode", mode, "--approve-via", `${paths.internalBaseUrl!.replace(/\/+$/, "")}/internal/approvals`, "--approval-timeout", String(tenant.limits.approvalTimeout ?? 600)]
    : ["--yes"];
  return [...asks, "--model", model, "--base-url", paths.baseUrl, "--max-steps", String(maxSteps), "--time-limit", String(timeLimit), "--events", paths.events, "--stats", paths.stats, "-C", paths.cwd, "-"];
}

/** Why a workspace file's path can't be written, or undefined if it lies inside the workspace. */
export function workspaceProblem(path: string): string | undefined {
  if (path === "" || path.includes("\0")) return "is empty or holds a NUL byte";
  if (isAbsolute(path) || /^[\\/]|^[a-zA-Z]:/.test(path)) return "is absolute";
  const parts = path.split(/[\\/]/);
  if (parts.includes("..")) return "leads out of the workspace (..)";
  if (["", "."].includes(parts.at(-1)!)) return "names a folder, not a file";
  return undefined;
}

/**
 * A workspace.git as git is to be given it, or what is wrong. With `gitHosts`, its host must be one of them,
 * and git is given the URL as URL reads it: git's curl reads `https://ok.host\@inside/` as userinfo before
 * the `@`, where URL reads the backslash as a slash, so the raw string could reach another host.
 */
export function checkedGit(git: string, gitHosts: string[] | undefined): { git: string } | { error: string } {
  if (!gitHosts) return { git };
  const url = URL.parse(git);
  if (!url || !gitHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase())) return { error: `workspace.git must be on one of the config's gitHosts: ${gitHosts.join(", ")}` };
  return { git: url.href };
}

// jig's exit codes (README: a task given on the command line exits with ...) and the stops they stand for.
const STOPS: Record<number, string> = { 0: "end_turn", 1: "error", 2: "max_steps", 3: "max_tokens", 4: "refusal", 5: "unapproved", 6: "loop", 7: "time_limit", 8: "empty", 130: "interrupted" };

/** The stop an exit code stands for, where the run left no end event to say. */
export function stopFor(exitCode: number | null): string {
  return (exitCode !== null && STOPS[exitCode]) || "error";
}

/**
 * A finished run's status. succeeded: the model finished (0). stopped: the run stopped short at a limit:
 * steps (2), the output limit or context window (3), repeating itself (6), the time limit (7, or the runner's
 * own stop past it), empty replies (8), or an interruption (130). failed: the model declined (4), or tool
 * calls needed approval (5). error: anything else, jig's own failures (1) and an unexplained signal included,
 * and a run stopped at the disk cap.
 */
export function statusFor(exit: { exitCode: number | null; timedOut?: boolean; cancelled?: boolean; overDisk?: string }): TaskStatus {
  if (exit.cancelled) return "cancelled";
  // The cap outranks the time limit, and a run that ended by itself in the same moment.
  if (exit.overDisk) return "error";
  if (exit.timedOut) return "stopped";
  switch (exit.exitCode) {
    case 0:
      return "succeeded";
    case 2:
    case 3:
    case 6:
    case 7:
    case 8:
    case 130:
      return "stopped";
    case 4:
    case 5:
      return "failed";
    default:
      return "error";
  }
}
