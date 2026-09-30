import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveInRoot } from "./util.ts";

/** Directories that are never worth searching, even when git doesn't ignore them. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", "dist", "build",
  ".next", "target",
]);
const MAX_FILES = 20_000;

/**
 * The files under `path` (a directory or a single file), as sorted paths relative to root. In a git
 * repository this is git's view of the project, so .gitignore applies; elsewhere it is a plain walk.
 */
export async function listFiles(root: string, path = "."): Promise<string[]> {
  const abs = resolveInRoot(root, path);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`No such file or directory: ${path}`);
  if (info.isFile()) return [relative(root, abs)];
  const files = (await gitFiles(root, abs)) ?? (await walk(root, abs, []));
  return files
    .filter((file) => !file.split("/").some((part) => SKIP_DIRS.has(part)))
    .slice(0, MAX_FILES)
    .sort();
}

/** Tracked and untracked files that git doesn't ignore, or null outside a git repository. */
function gitFiles(root: string, dir: string): Promise<string[] | null> {
  const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", dir];
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
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
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walk(root, abs, out);
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
