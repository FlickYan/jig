import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** jig's own directory: sessions, snapshots and user settings. $JIG_HOME, or ~/.jig. */
export function jigHome(): string {
  return process.env.JIG_HOME ?? join(homedir(), ".jig");
}

/**
 * A directory name for a project: its real path with / replaced by -, so a symlink to it is the same
 * project, then a short hash of that path, since paths have - in them too: /a/my-app and /a/my/app would
 * otherwise share one.
 */
export function projectKey(root: string): string {
  const real = realPath(root);
  return `${readable(real)}-${createHash("sha256").update(real).digest("hex").slice(0, 8)}`;
}

// What jig keeps for a project. The sessions go last: they are what shows whose an old key was (see migrate).
const STORES = ["snapshots", join("memory", "project"), "sessions"];

/**
 * A project's directory in one of jig's stores ("sessions", "memory/project", "snapshots"). Keys used to
 * be the readable path alone, so the first time, what was kept under the old keys moves here (see migrate).
 */
export function projectDir(store: string, root: string): string {
  const key = projectKey(root);
  if (!existsSync(join(jigHome(), store, key))) migrate(root, key);
  return join(jigHome(), store, key);
}

/**
 * Moves what a project kept under its old keys to its new one, if the sessions saved under them show it
 * was this project's: one started here, by the cwd its first line records, and none elsewhere. With no
 * session to go by, or one from another project, two projects may have shared it, and it all stays where
 * it is. The three stores move together, whichever is asked for first: once the sessions had moved alone,
 * nothing would tell a project whose path reads alike that the memories and snapshots left behind aren't
 * its own.
 */
function migrate(root: string, key: string): void {
  const real = realPath(root);
  // Sessions and snapshots went by the path as given, memory by the real path.
  const olds = [...new Set([readable(root), readable(real)])];
  const started = olds.flatMap(startedUnder);
  if (!started.length || started.some((cwd) => cwd !== real)) return;
  for (const store of STORES) for (const old of olds) move(join(jigHome(), store, old), join(jigHome(), store, key));
}

/** Puts an old directory in its new place, or what is in it there, if both exist and share no name. */
function move(old: string, dir: string): void {
  if (!existsSync(old)) return;
  try {
    if (!existsSync(dir)) {
      renameSync(old, dir);
      return;
    }
    // Sessions saved through a symlink and through its target go together. Two snapshot repositories
    // always have names in common (HEAD), so they never mix.
    const names = readdirSync(old);
    if (names.some((name) => existsSync(join(dir, name)))) return;
    for (const name of names) renameSync(join(old, name), join(dir, name));
    rmdirSync(old);
  } catch {
    // another jig moved it at the same moment, say: whatever is left stays under the old key
  }
}

/** The path with / (and \ and :) replaced by -: readable, but two paths can come out the same. */
function readable(path: string): string {
  return path.replace(/[\\/:]/g, "-");
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // not there (yet)
  }
}

/** Where the sessions saved under an old key started, as real paths. */
function startedUnder(key: string): string[] {
  const dir = join(jigHome(), "sessions", key);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const cwd = name.endsWith(".jsonl") ? startedIn(join(dir, name)) : undefined;
    return cwd === undefined ? [] : [realPath(cwd)];
  });
}

/**
 * The cwd a session file records. Its first line begins {"type":"start","cwd":...} and goes on with the
 * system prompt and the tools, so only the start of the file is read.
 */
function startedIn(file: string): string | undefined {
  try {
    const head = Buffer.alloc(8192);
    const fd = openSync(file, "r");
    try {
      const match = /^\{"type":"start","cwd":("(?:[^"\\]|\\.)*")/.exec(head.toString("utf8", 0, readSync(fd, head)));
      return match ? JSON.parse(match[1]) : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // unreadable: it tells us nothing
  }
}
