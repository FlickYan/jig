import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { assertVisible, isInside, realHiddenPaths, resolveInRoot, SAFE_GIT, withoutKeys } from "./util.ts";

/** Directories that are never worth searching, even when git doesn't ignore them. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", "dist", "build",
  ".next", "target",
]);
const MAX_FILES = 20_000;
// Kernel file systems, which a walk of / (--add-dir / in a container) would otherwise wander through.
const PSEUDO_FILESYSTEMS = new Set(["/proc", "/sys", "/dev"]);

/**
 * The files under `path` (a directory or a single file), sorted: relative to root for files in the
 * project, absolute for files in a directory added with --add-dir. In a git repository this is git's
 * view of the files, so .gitignore applies; elsewhere it is a plain walk. What the settings hide is left
 * out, wherever a symlink leads.
 */
export async function listFiles(root: string, path = ".", dirs: string[] = [], hidden: string[] = []): Promise<string[]> {
  const abs = resolveInRoot(root, path, dirs);
  await assertVisible(abs, path, hidden);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`No such file or directory: ${path}`);
  const base = isInside(root, abs) ? root : info.isFile() ? dirname(abs) : abs;
  const shown = (file: string) => (base === root ? file : join(base, file));
  if (info.isFile()) return [shown(relative(base, abs))];
  const files = (await gitFiles(base, abs)) ?? (await walk(base, abs, []));
  const listed = files
    .filter((file) => !file.split("/").some((part) => SKIP_DIRS.has(part)))
    .slice(0, MAX_FILES)
    .map(shown);
  return (await withoutHidden(root, listed, hidden)).sort();
}

/**
 * The files whose real path isn't hidden: a link in the project, or the walk of / that --add-dir / allows,
 * could reach one. It costs a realpath a file, so only with hidden paths set.
 */
async function withoutHidden(root: string, files: string[], hidden: string[]): Promise<string[]> {
  if (!hidden.length) return files;
  const unreadable = await realHiddenPaths(hidden);
  const real = await Promise.all(files.map((file) => realpath(resolve(root, file)).catch(() => "")));
  return files.filter((_, i) => !unreadable.some((path) => real[i] && isInside(path, real[i])));
}

/** Tracked and untracked files that git doesn't ignore, or null outside a git repository. */
function gitFiles(root: string, dir: string): Promise<string[] | null> {
  const args = [...SAFE_GIT, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", dir];
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, env: withoutKeys(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      // --cached also lists files deleted since the last commit.
      resolve(stdout.split("\0").filter((file) => file && existsSync(join(root, file))));
    });
  });
}

async function walk(root: string, dir: string, out: string[]): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    const abs = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !PSEUDO_FILESYSTEMS.has(abs)) await walk(root, abs, out);
    else if (entry.isFile()) out.push(relative(root, abs)); // symlinks are skipped, so walks can't loop
  }
  return out;
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
