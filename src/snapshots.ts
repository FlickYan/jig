import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { jigHome, projectKey } from "./paths.ts";
import { isInside } from "./tools/util.ts";

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
  private readonly taken: string[] = []; // commits, oldest first

  constructor(root: string) {
    this.root = root;
    this.gitDir = join(jigHome(), "snapshots", projectKey(root));
  }

  /** Records the project's current files. Throws if the project is too big to snapshot. */
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
      this.checkSize();
    }
    this.git("add", "--all", ".");
    this.git("-c", "user.name=jig", "-c", "user.email=jig@localhost", "commit", "-q", "--allow-empty", "--no-verify", "-m", label);
    this.taken.push(this.git("rev-parse", "HEAD").trim());
  }

  get count(): number {
    return this.taken.length;
  }

  /**
   * Puts the project's files back the way they were in the latest snapshot and forgets it, so the next
   * call goes one task further back. Returns undefined when there is no snapshot left.
   */
  undo(): Restored | undefined {
    const snapshot = this.taken.pop();
    if (!snapshot) return undefined;
    const restored: Restored = { changed: [], removed: [] };
    for (const [status, path] of this.diff(snapshot)) {
      if (status === "A") {
        removeFile(this.root, path);
        restored.removed.push(path);
      } else {
        restored.changed.push(path);
      }
    }
    if (restored.changed.length) this.git("checkout", snapshot, "--", ".");
    return restored;
  }

  /** The files changed, created or deleted since the latest snapshot, relative to the project; undefined without one. */
  changed(): string[] | undefined {
    const snapshot = this.taken.at(-1);
    return snapshot ? this.diff(snapshot).map(([, path]) => path) : undefined;
  }

  /** How the files differ from a snapshot: git's status letter and the path, for each file that does. */
  private diff(snapshot: string): [string, string][] {
    this.git("add", "--all", "."); // the index now describes the files as they are
    const fields = this.git("diff", "--cached", "--name-status", "--no-renames", "-z", snapshot).split("\0");
    const changes: [string, string][] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) changes.push([fields[i], fields[i + 1]]);
    return changes;
  }

  /** Snapshots copy the project's files, so refuse projects that would make them huge (big data files, say). */
  private checkSize(): void {
    let bytes = 0;
    for (const path of this.git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
      bytes += statSync(join(this.root, path), { throwIfNoEntry: false })?.size ?? 0;
    }
    if (bytes > MAX_PROJECT_BYTES) {
      rmSync(this.gitDir, { recursive: true, force: true });
      const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
      throw new Error(`the project has ${mb(bytes)} of files that aren't ignored, more than the ${mb(MAX_PROJECT_BYTES)} jig snapshots`);
    }
  }

  private git(...args: string[]): string {
    return execFileSync("git", [`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, ...args], {
      cwd: this.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
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
