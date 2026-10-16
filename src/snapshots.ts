import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { jigHome, projectKey } from "./paths.ts";
import { isInside, SAFE_GIT, withoutKeys } from "./tools/util.ts";

const MAX_PROJECT_BYTES = 200_000_000;
// Never snapshot these, even in a project without a .gitignore.
const EXCLUDES = [".git/", "node_modules/", ".venv/", "venv/", "__pycache__/", "dist/", "build/", "target/", ".next/", ".jig/"];

export interface Restored {
  changed: string[]; // modified or deleted since the snapshot, now put back
  removed: string[]; // created since the snapshot, now deleted
}

/**
 * Snapshots of a project's files, taken before each task so /undo can put them back. They live in a
 * private git repository (~/.jig/snapshots/<project>) whose work tree is the project, so this works in
 * any directory, honors .gitignore, and never touches the project's own repository, index or stash.
 */
export class Snapshots {
  private readonly root: string;
  private readonly gitDir: string;
  private readonly maxBytes: number;
  private readonly taken: string[] = []; // commits, oldest first

  constructor(root: string, maxBytes = MAX_PROJECT_BYTES) {
    this.root = root;
    this.gitDir = join(jigHome(), "snapshots", projectKey(root));
    this.maxBytes = maxBytes;
  }

  /** Records the project's current files. Throws if the project is too big to snapshot, or git fails. */
  take(label: string): void {
    if (this.root === homedir() || this.root === "/") throw new Error("jig doesn't snapshot your home directory or /");
    if (!existsSync(this.gitDir)) {
      mkdirSync(this.gitDir, { recursive: true });
      // A repository with no work tree of its own: every command passes the project as its work tree.
      execFileSync("git", ["init", "-q", "--bare", this.gitDir]);
      execFileSync("git", [`--git-dir=${this.gitDir}`, "config", "core.bare", "false"]);
      // jig's own directory is inside the project when jig runs in the home directory: never snapshot it.
      const home = relative(this.root, jigHome());
      const excludes = isInside(this.root, jigHome()) && home ? [...EXCLUDES, `/${home}/`] : EXCLUDES;
      writeFileSync(join(this.gitDir, "info", "exclude"), `${excludes.join("\n")}\n`);
    }
    // Before every snapshot, not just the first: a project can grow past the limit later (a dataset, say).
    this.checkSize();
    this.git("add", "--all", ".");
    this.git("-c", "user.name=jig", "-c", "user.email=jig@localhost", "commit", "-q", "--allow-empty", "--no-verify", "-m", label);
    this.taken.push(this.git("rev-parse", "HEAD").trim());
  }

  get count(): number {
    return this.taken.length;
  }

  /**
   * Puts the project's files back the way they were in the latest snapshot and forgets it, so the next
   * call goes one task further back. Returns undefined when there is no snapshot left. Throws if git fails
   * (a lock another git left, say), and keeps the snapshot so that the next call can try again.
   */
  undo(): Restored | undefined {
    const snapshot = this.taken.at(-1);
    if (!snapshot) return undefined;
    this.git("add", "--all", "."); // the index now describes the files as they are
    const restored: Restored = { changed: [], removed: [] };
    const fields = this.git("diff", "--cached", "--name-status", "--no-renames", "-z", snapshot).split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [status, path] = [fields[i], fields[i + 1]];
      if (status === "A") {
        removeFile(this.root, path);
        restored.removed.push(path);
      } else {
        restored.changed.push(path);
      }
    }
    if (restored.changed.length) this.git("checkout", snapshot, "--", ".");
    this.taken.pop();
    return restored;
  }

  /** Snapshots copy the project's files, so refuse projects that would make them huge (big data files, say). */
  private checkSize(): void {
    let bytes = 0;
    // What the next snapshot would hold: the files in the last one (--cached) and the new ones (--others).
    // lstat, since git stores a symlink as the path it points to: a link to a big file outside the project
    // adds only that path, and a link that loops is no error.
    for (const path of this.git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
      try {
        bytes += lstatSync(join(this.root, path), { throwIfNoEntry: false })?.size ?? 0; // deleted since the last one
      } catch {
        // ENOTDIR: a file has replaced its directory, and lstat throws for that whatever throwIfNoEntry says
      }
    }
    if (bytes > this.maxBytes) {
      // Earlier snapshots go too: going back to one now would also undo the coming task, which has none.
      rmSync(this.gitDir, { recursive: true, force: true });
      this.taken.length = 0;
      const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
      throw new Error(`the project has ${mb(bytes)} of files that aren't ignored, more than the ${mb(this.maxBytes)} jig snapshots`);
    }
  }

  private git(...args: string[]): string {
    // The user's git config applies here too, but its signing and hooks are for their own commits: a
    // signer that prompts or fails would stop every snapshot, and a global post-commit hook would run on it.
    const options = [...SAFE_GIT, "-c", "commit.gpgsign=false", `--git-dir=${this.gitDir}`, `--work-tree=${this.root}`];
    try {
      return execFileSync("git", [...options, ...args], {
        cwd: this.root,
        env: withoutKeys(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // What git said, rather than execFileSync's "Command failed:" and the whole command line.
      const said = (err as { stderr?: string }).stderr?.trim();
      throw said ? new Error(said) : err;
    }
  }
}

/** Deletes a file, and then any directories that removing it left empty. */
function removeFile(root: string, path: string): void {
  rmSync(join(root, path), { force: true });
  for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
    try {
      rmdirSync(join(root, dir));
    } catch {
      return; // not empty
    }
  }
}
