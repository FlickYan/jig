// Where a candidate of `bench/evolve.ts` is made: a copy of jig for it to change, which can't reach the
// benchmarks, and the way its change gets back into the repository, as a branch nobody has checked out.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** What the copy leaves out: the benchmarks (their tasks, hidden tests and results) and the evaluation. */
export const HIDDEN = [":(exclude,glob)bench/*/**", ":(exclude)eval"];

export const IDENTITY = ["-c", "user.name=jig evolve", "-c", "user.email=evolve@jig.invalid", "-c", "commit.gpgsign=false"];

/**
 * A copy of the repository at `base`, without what HIDDEN names, in a git repository of its own with one
 * commit: a worktree would share the repository's history, and through it the hidden tests (the analysis
 * of jig's attempts found it searching git history for them). Its dependencies are the repository's.
 */
export function workspace(root: string, base: string): string {
  const tree = join(mkdtempSync(join(tmpdir(), "jig-evolve-")), "jig");
  mkdirSync(tree);
  const archive = execFileSync("git", ["archive", "--format=tar", base, "--", ".", ...HIDDEN], { cwd: root, maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", tree], { input: archive });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tree });
  execFileSync("git", ["add", "-A"], { cwd: tree });
  execFileSync("git", [...IDENTITY, "commit", "-q", "-m", `jig at ${base}`], { cwd: tree });
  if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(tree, "node_modules"));
  return tree;
}

/** The files changed in a copy since it was made. */
export function changedFiles(tree: string): string[] {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: tree, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((file) => file !== "node_modules");
}

/** The copy's changes as a patch (binary files included). */
export function patchOf(tree: string): string {
  execFileSync("git", ["add", "-A", "--", ".", ":(exclude)node_modules"], { cwd: tree });
  return execFileSync("git", ["diff", "--cached", "--binary"], { cwd: tree, encoding: "utf8" });
}

/** Commits a patch on top of `base` as a new branch, without touching the checkout or its index. */
export function commitPatch(root: string, branch: string, base: string, patch: string, message: string[]): void {
  const index = join(mkdtempSync(join(tmpdir(), "jig-evolve-index-")), "index");
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_INDEX_FILE: index }, input, encoding: "utf8" }).trim();
  try {
    git(["read-tree", base]);
    git(["apply", "--cached", "--binary"], patch);
    const commit = git([...IDENTITY, "commit-tree", git(["write-tree"]), "-p", base, ...message.flatMap((part) => ["-m", part])]);
    git(["branch", branch, commit]);
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
}
