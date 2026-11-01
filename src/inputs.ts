// --keep-inputs: a line in a command's result when the command leaves a file that was there before the task
// gone or empty, and no other file in the project holds its bytes, saying where a copy of it as it was
// before the task is. In milestone 30's db-wal-recovery, the model's first look at a database with sqlite3
// deleted the task's only copy of its data, a write-ahead log whose header was invalid. The model had just
// worked out how to decode it; it looked for a copy for the rest of the trial, and in the end fetched the
// answer from the benchmark's repository. The copy comes from the snapshot taken before the task, or where
// git isn't installed (68 of that milestone's 76 trials), from a store kept only for this. jig never puts a
// file back itself: the model decides, with a command of its own.

import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { type FileHandle, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { projectDir } from "./paths.ts";
import { EXCLUDES, type Snapshots } from "./snapshots.ts";
import type { Mechanism } from "./stats.ts";
import type { OutputFiles } from "./tools/bash.ts";
import { globToRegExp } from "./tools/files.ts";
import { hiddenTest, readRegularFile, realTargetSync } from "./tools/util.ts";

/**
 * How many of the files that were there before the task are watched (the shallowest), the largest one the
 * store keeps, how much it keeps in all, and how many files are looked through for one holding a lost file's
 * bytes. An object, so that tests can lower them.
 */
export const inputLimits = { files: 5_000, fileBytes: 20_000_000, totalBytes: 100_000_000, candidates: 20_000 };

/** How many lost files one note names, each with its copy; it counts the rest. */
const NAMED = 5;

const gzipped = promisify(gzip);
const gunzipped = promisify(gunzip);

/** A file that was there before the task, as it was then. */
interface Input {
  /** Relative to the project. */
  path: string;
  size: number;
  mtimeMs: number;
  /** Seen to differ from how it was before the task: losing it later loses no bytes of then. */
  changed: boolean;
  /**
   * The hash of its bytes before the task, as Inputs' digest makes one of a file's bytes, so that a file
   * holding them is found without reading them back; undefined where jig can't tell (see inputLimits and
   * fromSnapshot).
   */
  hash?: string;
  /** Its bytes before the task, or undefined where jig kept none (see inputLimits). */
  bytes(signal?: AbortSignal): Promise<Buffer | undefined>;
}

/** A file a command left gone or empty, and where its copy is, once there is one. */
interface Lost {
  input: Input;
  how: "gone" | "empty";
  copy?: string;
}

export interface InputsOptions {
  /** The settings' hiddenPaths: never kept, given back or read for a comparison, by where they really lead. */
  hidden?: string[];
  /** Where the copies go (see OutputFiles.copy), deleted with the long outputs when jig exits. */
  outputs: OutputFiles;
  count?(event: Mechanism): void;
  notice(text: string): void;
}

/**
 * Watches the files that were there before a task, from its start (start) to its end, around each bash
 * command (before and after). A file is noted, once a task, only where all three hold: it was still as it was
 * before the task (its size and modification time) just before the command; it is gone, or empty, after it;
 * and no other file in the project holds its bytes from then. So a backup the model made (`cp x x.orig`)
 * keeps it quiet, as does a change since the task began (the model decoded the file in place, say, and a
 * later command deleted it), whether a command, write_file or edit_file made it. Files the task created
 * aren't watched. The note says the file is gone after the command, not that the command deleted it: a job
 * left in the background, or the user's editor, can do that between two commands.
 */
export class Inputs {
  private readonly root: string;
  private readonly hidden: string[];
  private readonly outputs: OutputFiles;
  private readonly count?: (event: Mechanism) => void;
  private readonly notice: (text: string) => void;
  private readonly watched = new Map<string, Input>();
  // How the watched files' hashes are made of their bytes: the store's, or git's (see fromSnapshot).
  private digest = sha256;
  // This session's store, once there is one (see fromStore), and whether the user has heard what it left out.
  private store?: string;
  private toldLeftOut = false;

  constructor(root: string, { hidden = [], outputs, count, notice }: InputsOptions) {
    this.root = root;
    this.hidden = hidden;
    this.outputs = outputs;
    this.count = count;
    this.notice = notice;
  }

  /**
   * Lists the files that were there before a task, to watch while it runs: from the snapshot taken before it
   * (`snapshots`, if there is one), or else from the store, which keeps them now. Not in the home directory
   * or at the root, nor in a project the settings hide, which the snapshots refuse too. Called in the task,
   * so that Ctrl+C and --time-limit (`signal`) stop it.
   */
  async start(snapshots: Snapshots | undefined, signal?: AbortSignal): Promise<void> {
    this.watched.clear();
    const real = realTargetSync(this.root);
    if (!real || real === dirname(real) || real === realTargetSync(homedir()) || hiddenTest(this.hidden, [this.root])(real)) return;
    const inputs = snapshots ? this.fromSnapshot(snapshots) : await this.fromStore(signal);
    // An empty file loses no bytes.
    for (const input of inputs) if (input.size > 0) this.watched.set(input.path, input);
  }

  /** Before a command: a file no longer as it was before the task, by whatever changed it, can't be noted. */
  before(): void {
    for (const input of this.watched.values()) {
      if (!input.changed && !unchanged(this.stat(input.path), input)) input.changed = true;
    }
  }

  /**
   * After a command: the line for its result, if it left a file that was there before the task gone or empty,
   * with its bytes in no other file of the project (see Inputs). Each such file is dropped from the watch,
   * noted or not. One that now leads into a hidden path (a folder on its way made a link there) is dropped
   * unsaid. Ctrl+C and --time-limit (`signal`) stop it.
   */
  async after(signal?: AbortSignal): Promise<string | undefined> {
    const lost: Lost[] = [];
    for (const input of this.watched.values()) {
      // A file changed but there is no loss yet: before() sees the change before the next command.
      const now = this.stat(input.path);
      const how = !now ? "gone" : now.isFile() && now.size === 0 ? "empty" : undefined;
      if (!how) continue;
      this.watched.delete(input.path);
      if (input.changed) this.count?.("inputs.suppressed");
      else lost.push({ input, how });
    }
    if (!lost.length) return undefined;
    const hides = hiddenTest(this.hidden, [this.root]);
    const shown = lost.filter(({ input }) => !hides(realTargetSync(join(this.root, input.path)) ?? ""));
    const held = await heldElsewhere(this.root, this.hidden, shown, this.digest, signal);
    for (const backedUp of held) if (backedUp) this.count?.("inputs.suppressed");
    const noted = shown.filter((_, i) => !held[i]);
    if (!noted.length) return undefined;
    // Only the files the note names are read back, for their copies: a command that lost a folder of thousands
    // has jig read five, not wait on git for each.
    for (const [i, one] of noted.entries()) {
      const bytes = i < NAMED ? await one.input.bytes(signal) : undefined;
      signal?.throwIfAborted();
      this.count?.("inputs.lost");
      one.copy = bytes && this.outputs.copy(basename(one.input.path), bytes);
      if (!one.copy) this.count?.("inputs.copySkipped");
    }
    return note(noted);
  }

  /** Deletes this session's store, and those of sessions no longer running (one killed, say): for jig's exit. */
  remove(): void {
    if (!this.store) return;
    const stores = dirname(this.store);
    try {
      for (const name of readdirSync(stores, { withFileTypes: true })) {
        const pid = Number(name.name);
        if (join(stores, name.name) === this.store || (name.isDirectory() && Number.isInteger(pid) && !running(pid))) {
          rmSync(join(stores, name.name), { recursive: true, force: true });
        }
      }
    } catch {
      // gone already, or not ours to remove: jig is exiting, which it shouldn't hold up
    }
  }

  /**
   * The snapshot's regular files, shallowest first, as the store lists them, read by the object that holds
   * their bytes: never a symlink, nor an older snapshot's file. A name that isn't UTF-8 is left out. Only
   * where git stored a file's bytes as they were is the object its copy, and its name its hash: where the
   * attributes or core.autocrlf have git make line endings LF, as the common `* text=auto` does, the object
   * holds other bytes (see Snapshots.converted for the others), and such a file is noted without a copy, as
   * one over the cap is.
   */
  private fromSnapshot(snapshots: Snapshots): Input[] {
    const files = (snapshots.files() ?? []).flatMap(({ path, ...rest }) => (Buffer.from(path.toString()).equals(path) ? [{ path: path.toString(), ...rest }] : []));
    files.sort((a, b) => depth(a.path) - depth(b.path));
    const watched = files.slice(0, inputLimits.files);
    const converted = snapshots.converted(watched.map(({ path }) => Buffer.from(path)));
    this.digest = gitHash(watched[0]?.object.length === 64 ? "sha256" : "sha1");
    const inputs: Input[] = [];
    for (const { path, object, size } of watched) {
      const info = this.stat(path);
      if (!info?.isFile()) continue;
      const hash = size === info.size && !converted.has(path) ? object : undefined;
      const kept = hash !== undefined && info.size <= inputLimits.fileBytes;
      // Where git fails, the file is noted without a copy.
      const bytes = async (signal?: AbortSignal) => (kept ? snapshots.blob(object, signal).catch(() => undefined) : undefined);
      inputs.push({ path, size: info.size, mtimeMs: info.mtimeMs, changed: false, hash, bytes });
    }
    return inputs;
  }

  /**
   * Without a snapshot, the files are kept now, for --keep-inputs only, in a folder of jig's own directory
   * for this session, which the sandbox hides from commands: each one gzipped and named by its bytes'
   * SHA-256, so that a file in several tasks is kept once, and where commands can read jig's directory (with
   * --no-sandbox, as on Terminal-Bench, where a model's grep found jig's session files) neither names nor
   * contents match a search for the project's. A file over inputLimits' caps isn't kept, which the user
   * hears once. It never feeds /undo: a copy that left files out would have it take them for files the task
   * made, and delete them. It holds one task's files: once they are listed, the blobs of the tasks before
   * that this one doesn't use go, as nothing reads them again, so that the caps hold however many tasks a
   * session runs (while a task's files are listed, the last task's are there too).
   */
  private async fromStore(signal?: AbortSignal): Promise<Input[]> {
    const store = (this.store ??= join(projectDir("inputs", this.root), String(process.pid)));
    mkdirSync(store, { recursive: true, mode: 0o700 });
    this.digest = sha256;
    const inputs: Input[] = [];
    const used = new Set<string>();
    let total = 0;
    let left = 0;
    try {
      for (const path of await projectFiles(this.root, this.hidden, inputLimits.files, true, signal)) {
        signal?.throwIfAborted();
        const input = await openRegular(join(this.root, path), async (handle, { size, mtimeMs }): Promise<Input | undefined> => {
          if (size === 0) return undefined;
          if (size > inputLimits.fileBytes || total + size > inputLimits.totalBytes) {
            left++;
            return { path, size, mtimeMs, changed: false, bytes: async () => undefined };
          }
          const bytes = await handle.readFile();
          total += bytes.length;
          const hash = sha256(bytes);
          used.add(`${hash}.gz`);
          const blob = join(store, `${hash}.gz`);
          if (!existsSync(blob)) {
            // Renamed into place, so that a blob is never there half written.
            const temp = `${blob}.${randomBytes(4).toString("hex")}.tmp`;
            writeFileSync(temp, await gzipped(bytes), { flag: "wx", mode: 0o600 });
            renameSync(temp, blob);
          }
          return { path, size, mtimeMs, changed: false, hash, bytes: () => unpack(blob) };
        });
        if (input) inputs.push(input);
      }
    } finally {
      for (const name of readdirSync(store)) if (!used.has(name)) rmSync(join(store, name), { force: true });
    }
    if (left && !this.toldLeftOut) {
      this.toldLeftOut = true;
      const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
      this.notice(`--keep-inputs keeps no copy of a file over ${mb(inputLimits.fileBytes)}, nor past ${mb(inputLimits.totalBytes)} in all, so it left out ${left} of the project's files: if a command removes one, the model hears so without a copy.`);
    }
    return inputs;
  }

  private stat(path: string): Stats | undefined {
    try {
      return lstatSync(join(this.root, path), { throwIfNoEntry: false });
    } catch {
      return undefined; // ENOTDIR: a file has replaced a folder on its way
    }
  }
}

/** Whether a file is still as it was before the task, by its size and modification time. */
function unchanged(now: Stats | undefined, input: Input): boolean {
  return !!now?.isFile() && now.size === input.size && now.mtimeMs === input.mtimeMs;
}

function depth(path: string): number {
  return path.split("/").length;
}

/**
 * The line for a command's result: each lost file NAMED names, with its size before the task and where its
 * copy is, or that there is none, and how many more there are.
 */
function note(noted: Lost[]): string {
  const said = noted.slice(0, NAMED).map(({ input, how, copy }) => {
    const where = copy ? `A copy of it as it was before the task is at ${copy}.` : "jig kept no copy of it.";
    return `${input.path}, which was there before the task (${input.size.toLocaleString("en-US")} bytes), is ${how} after this command, and no file in the project holds its bytes. ${where}`;
  });
  const more = noted.length - NAMED;
  if (more > 0) said.push(`${more} more file${more === 1 ? " that was" : "s that were"} there before the task ${more === 1 ? "is" : "are"} gone or empty too, with no copy.`);
  const them = noted.length === 1 ? "it" : "them";
  return `(Note from jig: ${said.join(" ")} If you removed ${them} on purpose, ignore this; restore ${them} only if the task needs those bytes.)`;
}

/**
 * For each lost file, whether another file in the project holds its bytes from before the task (a backup
 * the model made, say), by their hash (`digest`), so that the lost file's bytes aren't read back. Only files
 * of its size are read; without its hash (over the caps), any file of its size counts, so that jig stays
 * quiet where it can't tell.
 */
async function heldElsewhere(root: string, hidden: string[], lost: Lost[], digest: (bytes: Buffer) => string, signal?: AbortSignal): Promise<boolean[]> {
  const held = lost.map(() => false);
  let left = lost.length;
  const bySize = Map.groupBy(lost.keys(), (i) => lost[i].input.size);
  for (const path of await projectFiles(root, hidden, inputLimits.candidates, false, signal)) {
    if (!left) break;
    signal?.throwIfAborted();
    let info: Stats | undefined;
    try {
      info = lstatSync(join(root, path), { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!info?.isFile()) continue;
    let hash: string | undefined;
    for (const i of bySize.get(info.size) ?? []) {
      if (held[i]) continue;
      const before = lost[i].input.hash;
      if (before) hash ??= await openRegular(join(root, path), async (handle) => digest(await handle.readFile()));
      held[i] = !before || hash === before;
      if (held[i]) left--;
    }
  }
  return held;
}

/**
 * The project's regular files, relative to it, shallowest first, up to `limit`, as a snapshot would take
 * them: not in EXCLUDES' folders or in nested repositories, nor in what the hidden paths or jig's own
 * directory hold (by where they really are); with `gitignored`, not what the project's .gitignore files
 * ignore either, as far as jig reads them without git. Links aren't followed, so nothing outside is listed.
 */
async function projectFiles(root: string, hidden: string[], limit: number, gitignored: boolean, signal?: AbortSignal): Promise<string[]> {
  const real = realTargetSync(root) ?? root;
  const hides = hiddenTest(hidden, [root]);
  const skipped = new Set(EXCLUDES.map((dir) => dir.slice(0, -1)));
  const files: string[] = [];
  // A folder at a time, breadth first, so that the shallowest come first.
  let level: { dir: string; ignores: Ignore[] }[] = [{ dir: "", ignores: [] }];
  while (level.length) {
    const next: typeof level = [];
    for (const { dir, ignores: above } of level) {
      signal?.throwIfAborted();
      const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
      const ignores = gitignored ? [...above, ...ignoresIn(root, dir)] : above;
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (hides(join(real, path)) || ignored(ignores, path, entry.isDirectory())) continue;
        if (entry.isDirectory() && !skipped.has(entry.name) && !existsSync(join(root, path, ".git"))) next.push({ dir: path, ignores });
        else if (entry.isFile() && files.push(path) >= limit) return files;
      }
    }
    level = next;
  }
  return files;
}

/** A .gitignore's pattern, from the folder `base` (see ignoresIn). */
interface Ignore {
  base: string;
  pattern: RegExp;
  anchored: boolean;
  dirOnly: boolean;
}

/**
 * The patterns of the .gitignore in one of the project's folders, if it is a regular file: one with a slash
 * before its end matches the path from that folder, one without matches a name at any depth under it, and
 * one ending in a slash matches only folders. A negation (`!`) is left out, so the store keeps less than a
 * snapshot would, never more.
 */
function ignoresIn(root: string, dir: string): Ignore[] {
  let text: string | undefined;
  try {
    text = readRegularFile(join(root, dir, ".gitignore"), 1_000_000);
  } catch {
    return [];
  }
  return (text ?? "").split("\n").flatMap((line) => {
    const glob = line.trim();
    if (!glob || glob.startsWith("#") || glob.startsWith("!")) return [];
    const bare = glob.replace(/\/+$/, "");
    return bare ? [{ base: dir, pattern: globToRegExp(bare.replace(/^\//, "")), anchored: bare.includes("/"), dirOnly: bare !== glob }] : [];
  });
}

function ignored(ignores: Ignore[], path: string, isDir: boolean): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return ignores.some(({ base, pattern, anchored, dirOnly }) => (isDir || !dirOnly) && pattern.test(anchored ? path.slice(base ? base.length + 1 : 0) : name));
}

/**
 * `use` on a regular file, through a descriptor that neither follows a link nor waits on a named pipe, and
 * that file's stats; undefined for anything else, or nothing.
 */
async function openRegular<T>(abs: string, use: (handle: FileHandle, info: Stats) => Promise<T>): Promise<T | undefined> {
  const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    return info.isFile() ? await use(handle, info) : undefined;
  } finally {
    await handle.close();
  }
}

/** A blob's bytes, or undefined if they aren't those its name says (cut short, say). */
async function unpack(blob: string): Promise<Buffer | undefined> {
  try {
    const bytes = await gunzipped(await readFile(blob));
    return basename(blob) === `${sha256(bytes)}.gz` ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The name git gives an object that holds these bytes, in a repository whose names are made with
 * `algorithm`: a file holding a snapshot's object is then found without reading the object.
 */
function gitHash(algorithm: "sha1" | "sha256"): (bytes: Buffer) => string {
  return (bytes) => createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Whether a process is running, as a store's folder is named after its session's. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // someone else's
  }
}
