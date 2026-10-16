import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertVisible, isInside, realHiddenPaths, resolveInRoot, SAFE_GIT, withoutKeys } from "./util.ts";

/** Directories that are never worth searching when nobody added them to git: walks and untracked files skip them. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", "dist", "build",
  ".next", "target",
]);
// Kernel file systems, which a walk of / (--add-dir / in a container) would otherwise wander through.
const PSEUDO_FILESYSTEMS = new Set(["/proc", "/sys", "/dev"]);

/**
 * How many files a walk lists and grep reads at most, and how many seconds grep may spend in one file. An
 * object, so that tests can lower them.
 */
export const searchLimits = { files: 20_000, seconds: 30 };

export interface FileList {
  /** Sorted: relative to root for files in the project, absolute for files in a directory added with --add-dir. */
  files: string[];
  /** A walk stopped at searchLimits.files, so there are more files than these. */
  capped: boolean;
}

/**
 * The files under `path` (a directory or a single file). In a git repository this is git's view of the
 * files, so .gitignore applies, and all of it: matching names is cheap, and grep limits what it reads
 * itself. Elsewhere it is a plain walk, which stops at the limit, since with --add-dir / it would walk the
 * whole system. A path the settings hide is refused, but a file in the list can still be hidden, through a
 * symlink say: the caller leaves those out with firstVisible, on only the files it uses.
 */
export async function listFiles(root: string, path = ".", dirs: string[] = [], hidden: string[] = []): Promise<FileList> {
  const abs = resolveInRoot(root, path, dirs);
  await assertVisible(abs, path, hidden);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`No such file or directory: ${path}`);
  // Shown relative to the project, or in full in an --add-dir directory.
  const shown = isInside(root, abs) ? relative(root, abs) : abs;
  if (info.isFile()) return { files: [shown], capped: false };
  let files = await gitFiles(abs);
  let capped = false;
  if (!files) {
    files = await walk(abs, abs, [], searchLimits.files + 1); // one more than the limit, to tell there are more
    capped = files.length > searchLimits.files;
    files = files.slice(0, searchLimits.files);
  }
  return { files: files.map((file) => join(shown, file)).sort(), capped };
}

/**
 * The first `limit` of the files, in their order, whose real path the settings don't hide: a link in the
 * project, or the walk of / that --add-dir / allows, could reach a hidden one. It costs a realpath a file,
 * which for all the files of a large repository takes seconds, so it runs only on the files a tool uses:
 * those grep reads, or glob shows. `total` counts the files it didn't get to without checking them.
 */
export async function firstVisible(
  root: string,
  files: string[],
  limit: number,
  hidden: string[] = [],
): Promise<{ files: string[]; total: number }> {
  if (!hidden.length) return { files: files.slice(0, limit), total: files.length };
  const unreadable = await realHiddenPaths(hidden);
  const visible: string[] = [];
  let looked = 0;
  while (visible.length < limit && looked < files.length) {
    // As many at a time as are still wanted, since few files are hidden.
    const batch = files.slice(looked, looked + limit - visible.length);
    looked += batch.length;
    const real = await Promise.all(batch.map((file) => realpath(resolve(root, file)).catch(() => "")));
    for (const [i, file] of batch.entries()) {
      if (!unreadable.some((path) => real[i] && isInside(path, real[i]))) visible.push(file);
    }
  }
  return { files: visible, total: visible.length + files.length - looked };
}

/**
 * The files under dir that git doesn't ignore, relative to dir, or null outside a git repository. git runs
 * in dir itself, so in a nested repository it is that repository's git. Tracked files are all listed: a
 * tracked build/ or target/ is part of the project, and SKIP_DIRS is for what nobody added.
 */
async function gitFiles(dir: string): Promise<string[] | null> {
  const [tracked, untracked] = await Promise.all([lsFiles(dir, ["--cached"]), lsFiles(dir, ["--others", "--exclude-standard"])]);
  if (!tracked || !untracked) return null;
  const files: string[] = [];
  for (const file of [...tracked, ...untracked.filter((file) => !file.split("/").some((part) => SKIP_DIRS.has(part)))]) {
    const info = lstatSync(join(dir, file), { throwIfNoEntry: false });
    if (!info) continue; // --cached also lists files deleted since the last commit
    if (!info.isDirectory()) files.push(file);
    // A nested repository (a submodule, or a clone in the project) is one entry to git, so it is listed with
    // its own git, or walked where that fails: it is part of the project, so all of it. In a submodule that
    // was never checked out, git lists the directory itself, as "./".
    else if (resolve(dir, file) !== dir) {
      const nested = join(dir, file);
      for (const name of (await gitFiles(nested)) ?? (await walk(nested, nested, [], Infinity))) files.push(join(file, name));
    }
  }
  return files;
}

function lsFiles(dir: string, which: string[]): Promise<string[] | null> {
  const args = [...SAFE_GIT, "ls-files", ...which, "-z"];
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, env: withoutKeys(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.split("\0").filter(Boolean));
    });
  });
}

/** The files under dir, relative to root, up to `limit` of them. */
async function walk(root: string, dir: string, out: string[], limit: number): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) break;
    const abs = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !PSEUDO_FILESYSTEMS.has(abs)) await walk(root, abs, out, limit);
    else if (entry.isFile()) out.push(relative(root, abs)); // symlinks are skipped, so walks can't loop
  }
  return out;
}

/**
 * A glob from the model, made relative to `base`, the directory it is matched in: models often write
 * "./src/*.py" or an absolute path, which would otherwise match nothing.
 */
export function relativeGlob(glob: string, base: string): string {
  if (isAbsolute(glob)) return isInside(base, glob) ? relative(base, glob) : glob;
  return glob.replace(/^(\.\/)+/, "");
}

/** Converts a glob to a regular expression over "/"-separated paths: *, **, ?, {a,b} and [abc] work. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`);
}

function globSource(glob: string): string {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const dirs = glob[i + 2] === "/"; // "**/" is zero or more whole directories
      source += dirs ? "(?:.*/)?" : ".*";
      i += dirs ? 2 : 1;
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "{" && glob.indexOf("}", i) !== -1) {
      const end = glob.indexOf("}", i);
      source += `(?:${glob.slice(i + 1, end).split(",").map(globSource).join("|")})`;
      i = end;
    } else if (c === "[" && glob.indexOf("]", i) !== -1) {
      const end = glob.indexOf("]", i);
      source += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = end;
    } else {
      source += c.replace(/[.+^$()|[\]{}\\]/g, "\\$&");
    }
  }
  return source;
}
