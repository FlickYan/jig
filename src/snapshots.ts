import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { jigHome, projectDir } from "./paths.ts";
import { isInside, SAFE_GIT, withoutKeys } from "./tools/util.ts";

const MAX_PROJECT_BYTES = 200_000_000;
// Never snapshot these, even in a project without a .gitignore.
const EXCLUDES = [".git/", "node_modules/", ".venv/", "venv/", "__pycache__/", "dist/", "build/", "target/", ".next/", ".jig/"];
// Paths go back to git as the bytes it listed, on its standard input: a name a command picks needn't be
// valid UTF-8, and Node passes arguments as UTF-8, so a pathspec for such a name would match nothing.
const PATHSPECS_ON_STDIN = ["--pathspec-from-file=-", "--pathspec-file-nul"];
const SLASH = "/".charCodeAt(0);

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
    this.gitDir = projectDir("snapshots", root);
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
    // The index can hold nested repositories as gitlinks (older versions of jig stored them, and git add
    // stores one a command makes during a snapshot): drop them, so they are listed and left out as new ones are.
    const { tracked, gitlinks } = this.index();
    if (gitlinks.length) this.run(["update-index", "-z", "--force-remove", "--stdin"], nul(gitlinks));
    const { created, nested } = this.others();
    // Before every snapshot, not just the first: a project can grow past the limit later (a dataset, say).
    this.checkSize([...tracked, ...created]);
    this.run(["add", "--all", ...PATHSPECS_ON_STDIN], allBut(nested));
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
    // Compare with this snapshot's files: an earlier /undo left the index at the later one it went back to.
    // --reset keeps what git knows of the files that match, so it needn't read them all again, and doesn't
    // mind files edited since.
    this.git("read-tree", "--reset", snapshot);
    const { tracked, created } = this.changes(snapshot);
    for (const path of created) removeFile(this.root, path);
    if (tracked.length) this.run(["checkout", snapshot, ...PATHSPECS_ON_STDIN], allBut(this.index().gitlinks));
    this.taken.pop();
    return { changed: tracked, removed: created.map(String) };
  }

  /** The files changed, created or deleted since the latest snapshot, relative to the project; undefined without one. */
  changed(): string[] | undefined {
    const snapshot = this.taken.at(-1);
    if (!snapshot) return undefined;
    const { tracked, created } = this.changes(snapshot);
    return [...new Set([...tracked, ...created.map(String)])].sort();
  }

  /**
   * How the files differ from a snapshot the index holds: tracked files that differ or are gone, and the
   * files that are new, outside nested repositories. It only looks: adding the files first would copy
   * whatever the task created into the snapshots, however big, past the size check every snapshot makes.
   */
  private changes(snapshot: string): { tracked: string[]; created: Buffer[] } {
    // A snapshot can still hold a nested repository a command made while it was taken (see take), and diff
    // takes no pathspecs on its standard input: --ignore-submodules=all keeps git out of them all.
    const diff = this.list("diff", "--name-only", "--no-renames", "--ignore-submodules=all", "-z", snapshot);
    return { tracked: diff.map(String), created: this.others().created };
  }

  /**
   * The files in the index (the latest snapshot's, or the one undo went back to), and apart from them the
   * nested repositories it holds as gitlinks. Snapshots leave nested repositories (submodules, clones, or
   * one a command made) out: to see whether one it holds changed, git runs git status in it, and that runs
   * the programs its config names, a clean filter say, outside the sandbox.
   */
  private index(): { tracked: Buffer[]; gitlinks: Buffer[] } {
    const index = { tracked: [] as Buffer[], gitlinks: [] as Buffer[] };
    for (const entry of this.list("ls-files", "--stage", "-z")) {
      // "<mode> <object> <stage>\t<path>", and a gitlink's mode is 160000
      const path = entry.subarray(entry.indexOf("\t") + 1);
      (entry.toString("latin1", 0, 7) === "160000 " ? index.gitlinks : index.tracked).push(path);
    }
    return index;
  }

  /**
   * The files that are new, and apart from them the new nested repositories, which git lists as "dir/"
   * without running anything in them.
   */
  private others(): { created: Buffer[]; nested: Buffer[] } {
    const others = { created: [] as Buffer[], nested: [] as Buffer[] };
    for (const path of this.list("ls-files", "--others", "--exclude-standard", "-z")) {
      if (path.at(-1) === SLASH) others.nested.push(path.subarray(0, -1));
      else others.created.push(path);
    }
    return others;
  }

  /** Snapshots copy the project's files, so refuse projects that would make them huge (big data files, say). */
  private checkSize(files: Buffer[]): void {
    let bytes = 0;
    // lstat, since git stores a symlink as the path it points to: a link to a big file outside the project
    // adds only that path, and a link that loops is no error.
    for (const path of files) {
      try {
        bytes += lstatSync(inProject(this.root, path), { throwIfNoEntry: false })?.size ?? 0; // deleted since the last one
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

  /**
   * What a git command lists with -z, one entry each, as the bytes git wrote: a name needn't be valid
   * UTF-8, and decoded as UTF-8 it would no longer name the file.
   */
  private list(...args: string[]): Buffer[] {
    const output = this.run(args);
    const entries: Buffer[] = [];
    let start = 0;
    for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
      if (end > start) entries.push(output.subarray(start, end));
      start = end + 1;
    }
    return entries;
  }

  private git(...args: string[]): string {
    return this.run(args).toString();
  }

  /** Runs git, with input (if any) on its standard input, and returns what it printed. */
  private run(args: string[], input?: Buffer): Buffer {
    // The user's git config applies here too, but its signing and hooks are for their own commits: a
    // signer that prompts or fails would stop every snapshot, and a global post-commit hook would run on it.
    const options = [...SAFE_GIT, "-c", "commit.gpgsign=false", `--git-dir=${this.gitDir}`, `--work-tree=${this.root}`];
    try {
      return execFileSync("git", [...options, ...args], {
        cwd: this.root,
        env: withoutKeys(),
        input,
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // What git said, rather than execFileSync's "Command failed:" and the whole command line.
      const said = (err as { stderr?: Buffer }).stderr?.toString().trim();
      throw said ? new Error(said) : err;
    }
  }
}

/** Pathspecs, for git's standard input, for the whole project but these paths and what is under them, matched literally. */
function allBut(paths: Buffer[]): Buffer {
  return nul([Buffer.from("."), ...paths.map((path) => Buffer.concat([Buffer.from(":(exclude,literal)"), path]))]);
}

/** Paths for git's standard input, a NUL after each. */
function nul(paths: Buffer[]): Buffer {
  return Buffer.concat(paths.flatMap((path) => [path, Buffer.alloc(1)]));
}

/** A path git listed, in the project, as bytes for the file system. */
function inProject(root: string, path: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${root}/`), path]);
}

/** Deletes a file, and then any directories that removing it left empty. */
function removeFile(root: string, path: Buffer): void {
  rmSync(inProject(root, path), { force: true });
  for (let end = path.lastIndexOf(SLASH); end > 0; end = path.lastIndexOf(SLASH, end - 1)) {
    try {
      rmdirSync(inProject(root, path.subarray(0, end)));
    } catch {
      return; // not empty
    }
  }
}
