import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertVisible, hiddenTest, isInside, resolveInRoot, SAFE_GIT, withoutKeys } from "./util.ts";

/** Directories that are never worth searching when nobody added them to git: walks and untracked files skip them. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", "dist", "build",
  ".next", "target",
]);
// What a walk of a path git ignores skips, when the model named that path: it asked for what is in there.
const GIT_ONLY = new Set([".git"]);
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
  /** git took too long and was stopped (see gitOptions), so the files were walked, what it ignores included. */
  gitTimedOut: boolean;
}

/** What grep and glob add to their result when git took too long: the walk didn't leave out what git ignores. */
export function walkedNote(gitTimedOut: boolean): string {
  if (!gitTimedOut) return "";
  return `\n\n(git took over ${searchLimits.seconds}s to list the files, so they were walked instead, and files git ignores may be among them.)`;
}

/**
 * The files under `path` (a directory or a single file). In a git repository this is git's view of the
 * files, so .gitignore applies, and all of it: matching names is cheap, and grep limits what it reads
 * itself. Elsewhere it is a plain walk, which stops at the limit, since with --add-dir / it would walk the
 * whole system. A path git ignores is walked too, all of it but .git: git lists nothing in it, and the
 * model asked for it by name. A path the file tools hide is refused (see assertVisible), but a file in the
 * list can still be hidden, through a symlink say: the caller leaves those out with firstVisible, on only
 * the files it uses.
 */
export async function listFiles(root: string, path = ".", dirs: string[] = [], hidden: string[] = [], signal?: AbortSignal): Promise<FileList> {
  const abs = resolveInRoot(root, path, dirs);
  await assertVisible(abs, path, hidden, [root, ...dirs]);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`No such file or directory: ${path}`);
  // Shown relative to the project, or in full in an --add-dir directory.
  const shown = isInside(root, abs) ? relative(root, abs) : abs;
  if (info.isFile()) return { files: [shown], capped: false, gitTimedOut: false };
  const ignored = await ignoredByGit(abs, signal);
  const git = { timedOut: false };
  let files = ignored ? null : await gitFiles(abs, git, signal);
  let capped = false;
  if (!files) {
    // A path git ignores that the model named is walked whole but for .git: most packages in node_modules
    // keep their code in dist/ or build/. Not the project or an --add-dir directory, which an enclosing
    // repository (a home directory's) may ignore whole: their own node_modules and dist/ weren't asked for.
    const named = ignored && ![root, ...dirs].some((dir) => resolve(dir) === abs);
    // One more than the limit, to tell there are more.
    files = await walk(abs, abs, [], searchLimits.files + 1, named ? GIT_ONLY : SKIP_DIRS);
    capped = files.length > searchLimits.files;
    files = files.slice(0, searchLimits.files);
  }
  return { files: files.map((file) => join(shown, file)).sort(), capped, gitTimedOut: git.timedOut };
}

/**
 * The first `limit` of the files, in their order, whose real path the file tools don't hide (see
 * hiddenTest): a link in the project, or the walk of / that --add-dir / allows, could reach a hidden one,
 * or jig's own directory. It costs a realpath a file, which for all the files of a large repository takes
 * seconds, so it runs only on the files a tool uses: those grep reads (20,000 took half a second on
 * Linux), or glob shows. `total` counts the files it didn't get to without checking them.
 */
export async function firstVisible(
  root: string,
  files: string[],
  limit: number,
  hidden: string[] = [],
  dirs: string[] = [],
): Promise<{ files: string[]; total: number }> {
  const hides = await hiddenTest(hidden, [root, ...dirs]);
  const visible: string[] = [];
  let looked = 0;
  while (visible.length < limit && looked < files.length) {
    // As many at a time as are still wanted, since few files are hidden.
    const batch = files.slice(looked, looked + limit - visible.length);
    looked += batch.length;
    const real = await Promise.all(batch.map((file) => realpath(resolve(root, file)).catch(() => "")));
    for (const [i, file] of batch.entries()) {
      if (!real[i] || !hides(real[i])) visible.push(file);
    }
  }
  return { files: visible, total: visible.length + files.length - looked };
}

/**
 * The files under dir that git doesn't ignore, relative to dir, or null outside a git repository. git runs
 * in dir itself, so in a nested repository it is that repository's git. Tracked files are all listed: a
 * tracked build/ or target/ is part of the project, and SKIP_DIRS is for what nobody added. A git that took
 * too long sets git.timedOut.
 */
async function gitFiles(dir: string, git: { timedOut: boolean }, signal?: AbortSignal): Promise<string[] | null> {
  const [tracked, untracked] = await Promise.all([lsFiles(dir, ["--cached"], git, signal), lsFiles(dir, ["--others", "--exclude-standard"], git, signal)]);
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
      for (const name of (await gitFiles(nested, git, signal)) ?? (await walk(nested, nested, [], Infinity))) files.push(join(file, name));
    }
  }
  return files;
}

/**
 * Whether git ignores dir itself, as it often does node_modules/: git then lists nothing in it, and grep
 * said "No matches." there for text that was in it. Not when git tracks files in dir (a tracked build/ is
 * git's list), nor at a nested repository's top, which its own git lists. False outside a git repository.
 */
function ignoredByGit(dir: string, signal?: AbortSignal): Promise<boolean> {
  const args = [...SAFE_GIT, "check-ignore", "-q", "--", "."];
  return new Promise((resolve) => {
    // 0 when ignored, 1 when not, 128 outside a repository.
    execFile("git", args, gitOptions(dir, signal), (err) => resolve(!err));
  });
}

function lsFiles(dir: string, which: string[], git: { timedOut: boolean }, signal?: AbortSignal): Promise<string[] | null> {
  const args = [...SAFE_GIT, "ls-files", ...which, "-z"];
  return new Promise((resolve) => {
    execFile("git", args, { ...gitOptions(dir, signal), maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      // killed is set only when the timeout stopped it, not when the task did.
      if (err?.killed) git.timedOut = true;
      resolve(err ? null : stdout.split("\0").filter(Boolean));
    });
  });
}

/**
 * How the git that lists files runs in dir. git waits for as long as a named pipe is where it reads (a
 * .gitignore, .git/info/exclude, a nested repository's config), and a command can make one: so it stops
 * with the task, or after the seconds grep may spend in one file, and the files are then walked, as
 * outside a repository. The walk lists only regular files, so it opens no pipe; it doesn't leave out what
 * git ignores either, so after a timeout grep and glob say so (walkedNote).
 */
function gitOptions(dir: string, signal?: AbortSignal) {
  return { cwd: dir, env: withoutKeys(), signal, timeout: searchLimits.seconds * 1000 };
}

/** The files under dir, relative to root, up to `limit` of them, leaving out the directories named in skip. */
async function walk(root: string, dir: string, out: string[], limit: number, skip = SKIP_DIRS): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) break;
    const abs = join(dir, entry.name);
    if (entry.isDirectory() && !skip.has(entry.name) && !PSEUDO_FILESYSTEMS.has(abs)) await walk(root, abs, out, limit, skip);
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
