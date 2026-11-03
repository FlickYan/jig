import { type ChildProcess, execFileSync, type ExecFileSyncOptions, type IOType, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { jigHome } from "./paths.ts";
import { isGitControl, isInside, readRegularFile, realTargetSync, SAFE_GIT, withoutKeys } from "./tools/util.ts";

/** Where commands run when jig contains them (see createSandbox). */
export interface Sandbox {
  /** For the user, e.g. "macOS sandbox, no network". */
  description: string;
  /** For the model: what commands can't do. */
  limits: string;
  /** How to run `command` in bash inside the sandbox (see Wrapped, and execInSandbox for a run that waits). */
  wrap(command: string): Wrapped;
  /** Ends the session's keeper (Linux) and frees what it holds: for jig's exit (see Keeper). */
  close?(): void;
  /**
   * Those of the files telling git where its config is that commands created or changed since the last call,
   * the HEAD, objects or refs of a git directory they made git pass over, and, ending in a slash, a directory
   * they made a git directory. On Linux the sandbox can't keep a missing one of the first from being created,
   * and neither sandbox refuses a .git made in the project when jig runs in a subdirectory of the repository,
   * or the rest (see gitWatch), so jig says so after a task.
   */
  gitChanges?(): string[];
}

/** How a command runs in the sandbox (see Sandbox.wrap). */
export interface Wrapped {
  /**
   * The program and its arguments. They end with the command, run by bash -c, so arguments added after them
   * are its $0 and "$@" (see fetchSource).
   */
  program: string;
  args: string[];
  /**
   * On Linux, what the spawn must pass on beyond stdio, at child descriptors 3 onwards: the session's
   * namespaces, and a pipe on which bubblewrap reports the command's process before it starts it (see Keeper).
   */
  stdio?: (number | "pipe")[];
  /** For the model, with the command's result: on Linux, once, that a job left in the background ends with its command here (see Keeper). */
  note?: string;
  /**
   * For a run that failed, given what came out of the pipe: whether bubblewrap couldn't join the session's
   * namespace, which had just ended, and so started nothing. Then the command, wrapped again, runs in a new
   * one; once, whatever comes of it (see Keeper).
   */
  couldntJoin?(reported: string): boolean;
}

/**
 * Runs `command` in the sandbox, `args` after it (bash's $0 and "$@"), as execFileSync runs a program, `stdio`
 * being its first three descriptors: once more, wrapped again, if bubblewrap couldn't join the session's
 * namespace (see Wrapped.couldntJoin). A timeout, or output past maxBuffer, kills the command's process (bash,
 * or the program bash runs in its place), so the command goes no further; what it started runs on, as it
 * would outside the sandbox, on Linux until the session's namespace ends (see Keeper).
 */
export function execInSandbox(sandbox: Sandbox, command: string, args: string[], options: Omit<ExecFileSyncOptions, "encoding" | "stdio"> & { stdio: IOType[] }): Buffer {
  for (let again = false; ; again = true) {
    const { program, args: wrapped, stdio = [], couldntJoin } = sandbox.wrap(command);
    try {
      return execFileSync(program, [...wrapped, ...args], { ...options, stdio: [...options.stdio, ...stdio] });
    } catch (err) {
      // execFileSync's error holds what came out of each descriptor, the pipe bubblewrap reports on among them.
      const { output, signal } = err as { output?: (Buffer | null)[]; signal?: string | null };
      const pipe = stdio.indexOf("pipe");
      const reported = pipe < 0 ? "" : (output?.[3 + pipe]?.toString() ?? "");
      if (signal) {
        // execFileSync killed bubblewrap (a timeout, or output past maxBuffer), which leaves a command that joined
        // the session's namespace running: so kill the process bubblewrap reported, the command's, as the
        // --die-with-parent that joins leave out did (see Keeper). In the fallback that flag does it, and on
        // macOS the program execFileSync ran is the command's own. A run killed so never runs again.
        const pid = /"child-pid":\s*(\d+)/.exec(reported)?.[1];
        if (pid) try { process.kill(Number(pid), "SIGKILL"); } catch {} // it has exited
        throw err;
      }
      if (again || !couldntJoin?.(reported)) throw err;
    }
  }
}

/** What the sandbox keeps commands from changing in a repository (see gitControl). */
export interface GitControl {
  /** Config, hooks and the files that say where they are, whether they exist or not. */
  locked: string[];
  /**
   * The git directory and the directories between it and those, which can't be moved aside either, and
   * those between them and a writable directory they lie in (see keptInPlace).
   */
  fixed: string[];
  /** The repository's git directories, its linked worktrees' and its submodules', which commands can make git pass over (see gitWatch). */
  gitDirectories: string[];
  /** Set when they are all a repository's around the project's, which is a bare one left writable (see gitControl). */
  aroundOnly?: boolean;
}

/**
 * A repository's git directories: the common one, and the work tree's own (a linked worktree's, under the
 * common one's worktrees/), whether the repository is bare rather than one with a work tree, and where the
 * walk found it: the directory holding its .git, or the bare one itself (not known when git was asked).
 */
interface GitDirs {
  common: string;
  own: string;
  bare: boolean;
  tree?: string;
}

/** The git directories a .git leads to, and the directory holding that .git (see gitDirsOf). */
type Found = Omit<GitDirs, "bare"> & { tree: string };

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const GIT_FILE_BYTES = 65_536; // read of a file that tells git where things are: it holds a path, or a little config

/**
 * Commands run in the operating system's own sandbox, the way Codex and Claude Code sandbox them:
 * Seatbelt on macOS, bubblewrap on Linux. Either way they can read anything, but write only inside the
 * project, its git directory (not what gitControl lists), the directories added with --add-dir and the
 * temp directories, and without `network` they have no IP network (Unix sockets stay open). Unlike a
 * container, this keeps the user's own toolchain (python, node, compilers) working with no setup. The
 * `hidden` paths they can't read at all, nor jig's own directory but its skills (see ownRules). Returns
 * undefined where there is no sandbox; sandboxProblem says why.
 */
export function createSandbox(
  root: string,
  { network, dirs = [], hidden = [], onFallback }: { network: boolean; dirs?: string[]; hidden?: string[]; onFallback?: () => void },
): Sandbox | undefined {
  if (sandboxProblem()) return undefined;
  const project = realpathSync(root); // Seatbelt sees real paths: /var is /private/var
  const unreadable = hidden.filter((path) => existsSync(path)).map((path) => realpathSync(path));
  const home = realTargetSync(jigHome()); // made with the first session, if it isn't there yet
  const added = dirs.map((dir) => realpathSync(dir));
  const temp = process.platform === "darwin" ? ["/private/tmp"] : ["/tmp", "/var/tmp"].filter((dir) => existsSync(dir));
  const repo = gitDirs(project);
  const writable = [project, repo?.common, ...added, realpathSync(tmpdir()), ...temp].filter(
    (dir, i, all): dir is string => !!dir && !all.slice(0, i).some((other) => other && isInside(other, dir)),
  );
  const where = `inside the project${added.length ? `, ${added.join(", ")}` : ""} and the temp directories`;
  // git runs the programs a repository's config and hooks name, outside the sandbox: the user's git after
  // the session (a shell prompt may run it at every line), and jig's own if jig didn't turn them off. So
  // commands can't change them, or the files that say where they are.
  const guarded = gitControl(project, repo, writable);
  const sandbox =
    process.platform === "darwin"
      ? seatbelt(writable, network, where, unreadable, guarded, home)
      : bubblewrap(writable, network, where, unreadable, guarded, home, onFallback);
  return guarded ? { ...sandbox, gitChanges: gitWatch(guarded, project, repo?.tree) } : sandbox;
}

/**
 * What in a repository tells git which programs to run, for the sandbox to keep commands from changing:
 * the config and hooks of its git directory and of its submodules' (under modules/, nested ones too), and
 * the files that say where those are. That is a commondir or config.worktree in any of them, every linked
 * worktree's own commondir, gitdir and config.worktree (not only this one's: the user runs git in the
 * others too), and the .git file of every worktree and submodule checkout. As isGitControl has it for the
 * file tools. Undefined outside a repository, and for a bare one (as git says, not by its name: a git
 * directory made with --separate-git-dir has no .git in its path), where setting up a server's hooks can
 * be the task. But not for a bare one named .git, whose config the file tools refuse too, nor for one with
 * linked worktrees, which is no server's: the user runs git in them (a bare clone, its worktrees beside it).
 * And the repositories around this one leave locked what they have in a writable directory, `writable`
 * being the sandbox's, or the project and its git directory (see aroundControl). Where a writable
 * directory holds what is locked, the directories between them can't be moved aside (see keptInPlace).
 */
export function gitControl(project: string, repo = gitDirs(project), writable?: string[]): GitControl | undefined {
  if (!repo) return undefined;
  const dirs = writable ?? [realpathSync(project), repo.common];
  const around = aroundControl(project, repo, dirs);
  if (repo.bare && !worktrees(repo.common).length && !isGitControl(join(repo.common, "config"))) {
    return around && keptInPlace({ ...around, aroundOnly: true }, dirs);
  }
  const own = controlOf(repo, dotGitFile(project));
  if (!around) return keptInPlace(own, dirs);
  const merged = (key: "locked" | "fixed" | "gitDirectories") => [...new Set([...own[key], ...around[key]])];
  return keptInPlace({ locked: merged("locked"), fixed: merged("fixed"), gitDirectories: merged("gitDirectories") }, dirs);
}

/**
 * A control with the directories between what it locks and the outermost writable directory it lies in
 * fixed too, as holding has them for a hidden path, the outermost first. controlOf fixes only those in the
 * git directory, so with the project in a directory in a temp one (a clone in /tmp/work/repo), a command
 * could move work aside, put a copy of the repository with a config of its own in its place, and leave the
 * user's git to run what that names: no rule named the new config's path, and gitWatch doesn't look at a
 * config. Binding them grants nothing, as they lie in a writable directory already. Not for the .git files
 * of worktrees and submodule checkouts: fixing every directory above a checkout in the project would keep
 * commands from renaming them, and a .git put in one's place is refused by Seatbelt, which denies the path,
 * or reported by gitWatch, which looks at every one.
 */
function keptInPlace(control: GitControl, writable: string[]): GitControl {
  const between = holding(control.locked.filter((path) => basename(path) !== ".git"), writable);
  const fixed = [...new Set([...control.fixed, ...between])].sort((a, b) => a.length - b.length); // a directory before those in it
  return { ...control, fixed };
}

/**
 * What gitControl locks, for the file tools to refuse too, whether there is a sandbox or not: they run
 * outside it, and isGitControl knows a git directory only by the name .git. One by another name (made with
 * --separate-git-dir in the project, a bare clone a .git file names) was theirs to change, a hook included,
 * though commands couldn't. Of the repositories around the project's, what lies where the file tools can
 * change files: the project and `dirs`. By real path, as they check a change (a locked file can be a
 * link), and worked out once a session, as the sandbox's lock is.
 */
export function lockedGitPaths(project: string, dirs: string[] = []): string[] {
  const real = realpathSync(project);
  const locked = gitControl(real, undefined, [real, ...dirs.map((dir) => realpathSync(dir))])?.locked ?? [];
  return locked.flatMap((path) => realTargetSync(path) ?? []);
}

/**
 * What the repositories around the project's have in a writable directory (`writable`, by real path),
 * for gitControl to lock: the .git of a submodule checkout in the project, say, or the config of one in a
 * temp directory. A command can make a repository wherever it can write, bare (git init --bare .) or not
 * (git init). Made in the directory holding a submodule's checkout, the next session there, or in a
 * subdirectory, took it for the repository and locked nothing of the one around, and a command in it could
 * point the checkout's .git at a git directory with a config of its own, which the user's git status in
 * the repository around then read. The directories holding those files are fixed only where they lie in a
 * writable directory already, as binding them there grants nothing: those repositories' git directories
 * aren't the project's, so they are never made writable (bubblewrap makes what it binds writable).
 */
function aroundControl(project: string, repo: GitDirs, writable: string[]): GitControl | undefined {
  const inWritable = (path: string) => writable.some((dir) => isInside(dir, path));
  const controls = repositoriesAround(repo.tree ?? project, repo.common).map((outer) => controlOf(outer, dotGitFile(outer.tree)));
  const kept = (key: "locked" | "fixed" | "gitDirectories") => [...new Set(controls.flatMap((control) => control[key].filter(inWritable)))];
  const locked = kept("locked");
  // Any of their git directories there has its config there too.
  return locked.length ? { locked, fixed: kept("fixed"), gitDirectories: kept("gitDirectories") } : undefined;
}

/**
 * The repositories the .git files above `tree` lead to, going no further up than gitDirs does
 * (GIT_CEILING_DIRECTORIES): all of them, as a command can make a repository inside one it made before.
 * Not the one whose git directory is `common`, which a .git above can name too.
 */
function repositoriesAround(tree: string, common: string): Found[] {
  const ceilings = gitCeilings();
  const found: Found[] = [];
  for (let dir = dirname(tree); !ceilings.includes(dir); dir = dirname(dir)) {
    const repo = existsSync(join(dir, ".git")) ? gitDirsOf(join(dir, ".git")) : undefined;
    if (repo && repo.common !== common && !found.some((other) => other.common === repo.common)) found.push(repo);
    if (dirname(dir) === dir) break;
  }
  return found;
}

/** What gitControl lists for a repository whose work tree's .git, if it is a file, is `dotGit`. */
function controlOf({ common, own }: Pick<GitDirs, "common" | "own">, dotGit: string | undefined): GitControl {
  const inGitDir = (dir: string) => [
    ...["config", "config.worktree", "commondir", "hooks"].map((name) => join(dir, name)),
    ...worktrees(dir).flatMap((tree) => ["commondir", "gitdir", "config.worktree"].map((name) => join(tree, name))),
  ];
  // A linked worktree's submodules have their git directories in its own (worktrees/<name>/modules).
  const modules = [...new Set([common, own, ...worktrees(common)])].flatMap((dir) => submodules(join(dir, "modules")));
  const dotGits = [dotGit, ...worktrees(common).map(worktreeDotGit), ...checkoutDotGits(modules)];
  const locked = [...[common, ...modules].flatMap(inGitDir), ...new Set(dotGits.filter((path) => path !== undefined))];
  // Moved aside, a directory holding them could be replaced by one with files of a command's own.
  const fixed = new Set([common]);
  for (const path of locked) {
    for (let dir = dirname(path); dir !== common && isInside(common, dir); dir = dirname(dir)) fixed.add(dir);
  }
  const outerFirst = [...fixed].sort((a, b) => a.length - b.length); // a directory before those in it
  return { locked, fixed: outerFirst, gitDirectories: [common, ...worktrees(common), ...modules] };
}

/** The directories git (and Git LFS) keeps in a git directory, where no submodule's git directory is. */
const GIT_OWN = new Set(["hooks", "info", "lfs", "logs", "objects", "refs", "worktrees"]);

/**
 * The git directories of submodules under a modules directory (`top`, which is none itself), nested ones
 * too: those with a config or a HEAD. Not only a HEAD, which commands can move aside, as git changes it all
 * the time: the next session would then lock nothing there, and a command could change the config and put
 * the HEAD back. The config is locked, so it stays. And a submodule's name can hold slashes (libs/s), so
 * the search goes on inside one, past git's own directories: a command could otherwise hide libs/s by
 * putting a HEAD in modules/libs.
 */
function submodules(dir: string, top = true): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const gitDir = !top && entries.some((entry) => entry.name === "config" || entry.name === "HEAD");
  const inside = entries.filter((entry) => entry.isDirectory() && !(gitDir && GIT_OWN.has(entry.name)));
  return [...(gitDir ? [dir] : []), ...inside.flatMap((entry) => submodules(join(dir, entry.name), false))];
}

/** A git directory's linked worktrees' own directories, under its worktrees/. */
function worktrees(dir: string): string[] {
  try {
    return readdirSync(join(dir, "worktrees"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, "worktrees", entry.name));
  } catch {
    return [];
  }
}

/** The .git git finds from the project if it is a file: a linked worktree's or a submodule's pointer to its git directory. */
function dotGitFile(project: string): string | undefined {
  for (let dir = project; ; dir = dirname(dir)) {
    const info = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
    if (info) return info.isFile() ? join(dir, ".git") : undefined;
    if (dirname(dir) === dir) return undefined;
  }
}

/** A linked worktree's .git file, which its gitdir file names. */
function worktreeDotGit(tree: string): string | undefined {
  try {
    // A command can make a worktree's directory, with a named pipe for its gitdir.
    const gitdir = readRegularFile(join(tree, "gitdir"), GIT_FILE_BYTES);
    return gitdir === undefined ? undefined : dotGitIn(dirname(resolve(tree, gitdir.trim())));
  } catch {
    return undefined;
  }
}

/**
 * Submodule checkouts' .git files, from where each submodule's config says its checkout is (core.worktree,
 * relative to its git directory). The user's git status in the superproject runs git in the checkout,
 * so a .git file there pointing elsewhere would have it run a config of a command's own.
 */
function checkoutDotGits(modules: string[]): (string | undefined)[] {
  const trees = checkoutTrees(modules);
  return modules.map((module) => {
    const tree = trees.get(module);
    return tree === undefined ? undefined : dotGitIn(resolve(module, tree));
  });
}

/**
 * core.worktree in submodules' configs, by submodule, as git config --file reads each. One git reads them
 * all, as includes of a config on its standard input: a superproject, or a dotfiles repository around the
 * project's, can have dozens of submodules, and each git takes milliseconds to start. But --file follows
 * no include a config has itself (one could name a named pipe, which git would wait on), so if any config
 * has one, each is read alone, as each is if git fails on one. git would wait on a config that is a named
 * pipe too, as a command can leave in a submodule's directory it made, so only regular files are read.
 */
function checkoutTrees(modules: string[]): Map<string, string> {
  const configs = modules.map((module) => join(module, "config")).filter((config) => {
    try {
      return statSync(config).isFile();
    } catch {
      return false; // not there, or a link to itself (ELOOP)
    }
  });
  if (!configs.length) return new Map();
  const list = (args: string[], input?: string) =>
    execFileSync("git", [...SAFE_GIT, "config", ...args, "--show-origin", "-z", "--list"], { env: withoutKeys(), encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] })
      .split("\0")
      .slice(0, -1);
  let fields: string[];
  try {
    if (configs.some((config) => /include/i.test(readRegularFile(config) ?? ""))) throw new Error("a config includes another");
    const quoted = (path: string) => `"${path.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n")}"`;
    fields = list(["--file", "-", "--includes"], `[include]\n${configs.map((config) => `\tpath = ${quoted(config)}\n`).join("")}`);
  } catch {
    fields = configs.flatMap((config) => {
      try {
        return list(["--file", config]);
      } catch {
        return []; // one git can't read
      }
    });
  }
  // Each entry is where it is from (file:<path>), then its key and its value, a line apart. The last counts.
  const trees = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [origin, entry] = [fields[i], fields[i + 1]];
    const at = entry.indexOf("\n");
    if (!origin.startsWith("file:") || at === -1 || entry.slice(0, at) !== "core.worktree") continue;
    trees.set(dirname(origin.slice("file:".length)), entry.slice(at + 1));
  }
  return trees;
}

/**
 * A work tree's .git by its real path (Seatbelt sees no other), unless it is a directory: then it is a
 * repository of its own. Where the work tree is a file, a link to itself or a directory jig can't search,
 * as a submodule's checkout can be once git has left its git directory behind, it is locked as one that
 * isn't there yet: looking threw, which stopped jig starting, the sandbox or not.
 */
function dotGitIn(tree: string): string | undefined {
  const path = join(existsSync(tree) ? realpathSync(tree) : tree, ".git");
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? undefined : path;
  } catch {
    return path; // ENOTDIR, ELOOP or EACCES
  }
}

/**
 * Which of the files that tell git where its config is commands created or changed, since the last call:
 * those that weren't there when the sandbox was made, and the .git files. bubblewrap can only make a path
 * read-only by binding something over it, and binding one that isn't there creates it, empty: an empty
 * commondir would break git. So the sandbox can't stop a command creating one, and git would then take
 * its config from wherever it points. Nor can it keep a submodule's checkout in place without fixing
 * every directory above it in the project: moved aside, it can be replaced by a repository with a config
 * of the command's own. Seatbelt refuses a new commondir or .git alike, short of a symlink in a checkout's
 * place, which shows here as a .git with another real path. One that is removed isn't reported: git then
 * reads no config there. When jig runs in a subdirectory of the repository, a .git a command makes in
 * the project, or in a directory above it up to the repository's (one in a temp directory, say), is
 * reported too: the user's git there would then take its config from where that leads. So is the project,
 * or such a directory, made a git directory (git init --bare .), which git there takes for the repository.
 * Neither sandbox refuses them, since making a repository there can be the task. Last, a git directory's
 * HEAD, objects or refs, if a command removed or broke them so that git passes over it (see passedOver):
 * commands can write them, as git changes them all the time. The user's git there then fails, or takes a
 * repository above it for the one it is in. jig still finds it, and locks it (see gitDirs).
 */
function gitWatch({ locked, gitDirectories }: GitControl, project: string, tree: string | undefined): () => string[] {
  // The project and the directories above it up to where the repository was found, none of which has a
  // .git: the project alone where git was asked.
  const between: string[] = [];
  for (let dir = project; dir !== tree; dir = dirname(dir)) {
    between.push(dir);
    if (!tree || !isInside(tree, dirname(dir))) break;
  }
  const dotGits = between.map((dir) => join(dir, ".git")).filter((path) => !existsSync(path));
  const watched = [...new Set([...locked, ...dotGits])].filter(
    (path) => basename(path) === ".git" || (basename(path) !== "hooks" && !existsSync(path)),
  );
  const seen = new Map(watched.map((path) => [path, contents(path)]));
  const passed = new Map(gitDirectories.map((dir) => [dir, passedOver(dir)]));
  const made = new Map(between.map((dir) => [dir, isGitDirectory(dir)]));
  return () => [
    ...watched.filter((path) => {
      const now = contents(path);
      if (now === undefined || now === seen.get(path)) return false;
      seen.set(path, now);
      return true;
    }),
    ...gitDirectories.flatMap((dir) => {
      const now = passedOver(dir);
      const before = passed.get(dir);
      passed.set(dir, now);
      return now !== undefined && now !== before ? [now] : [];
    }),
    ...between.flatMap((dir) => {
      const now = isGitDirectory(dir);
      const before = made.get(dir);
      made.set(dir, now);
      return now && !before ? [`${dir}${sep}`] : [];
    }),
  ];
}

/**
 * Why git would pass over a git directory, as its is_git_directory has it: its HEAD, if that is gone or
 * names neither a ref nor a commit, or its objects or refs, if gone. A linked worktree's are in the common
 * directory, which its commondir names and which is watched itself, as is a commondir a command made.
 * Undefined if git wouldn't, or the directory is gone: the user may remove a worktree during the session,
 * and commands can't move one that was there when it began.
 */
function passedOver(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const head = join(dir, "HEAD");
  if (!headInOrder(head)) return head;
  if (existsSync(join(dir, "commondir"))) return undefined;
  return ["objects", "refs"].map((name) => join(dir, name)).find((path) => !existsSync(path));
}

/**
 * Whether git takes a directory for a git directory, as its is_git_directory has it: a HEAD in order, and
 * objects and refs in the directory its commondir names (taking only line breaks off its end), or in
 * itself if it has none. A commondir a command made can name nothing, and git then passes it over.
 */
function isGitDirectory(dir: string): boolean {
  if (!existsSync(dir) || !headInOrder(join(dir, "HEAD"))) return false;
  let common = dir;
  try {
    const named = readRegularFile(join(dir, "commondir"), GIT_FILE_BYTES);
    if (named !== undefined) common = resolve(dir, named.replace(/[\r\n]+$/, ""));
  } catch {
    // not to be read (EACCES), which git fails on
  }
  return existsSync(join(common, "objects")) && existsSync(join(common, "refs"));
}

/** Whether a HEAD names a ref or a commit, as git checks it: a link into refs/, or a file starting "ref: refs/" or with a commit's hash. */
function headInOrder(head: string): boolean {
  try {
    if (lstatSync(head).isSymbolicLink()) return readlinkSync(head).startsWith("refs/");
    return /^(ref:\s*refs\/|[0-9a-fA-F]{40})/.test(readRegularFile(head, GIT_FILE_BYTES) ?? "");
  } catch {
    return false; // not there, or not to be read
  }
}

/**
 * What is at a path, to tell whether it changed: where it really is, its kind (by its mode), and a regular
 * file's size and the start of its text. Undefined if nothing is. Only a regular file is read: a command
 * can put a named pipe there, or a link to /dev/zero, and reading either hung jig after the task. Those,
 * and a directory, are told apart by their kind alone.
 */
function contents(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    const info = statSync(real);
    const file = info.isFile() ? [info.size, readRegularFile(real, GIT_FILE_BYTES)] : [];
    return JSON.stringify([real, info.mode & constants.S_IFMT, ...file]);
  } catch {
    return undefined;
  }
}

/** Why there is no sandbox on this machine, or undefined if there is one. */
export function sandboxProblem(): string | undefined {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? undefined : `${SANDBOX_EXEC} is missing`;
  if (process.platform === "linux") return (bubblewrapProblem ??= checkBubblewrap()) || undefined;
  return `jig has no sandbox for ${process.platform} yet`;
}

function seatbelt(writable: string[], network: boolean, where: string, hidden: string[], git?: GitControl, home?: string): Sandbox {
  const profile = seatbeltProfile(writable, network, hidden, git, home);
  return {
    description: `macOS sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : ", and can't use the network except localhost"}${gitNote(git)}${hiddenNote(hidden)}${ownNote(home)}.`,
    wrap: (command) => ({ program: SANDBOX_EXEC, args: ["-p", profile, "/bin/bash", "-c", CLEAN_START, command] }),
  };
}

/**
 * How a sandboxed command starts: a bash that closes every descriptor but stdin, stdout and stderr, then
 * runs the command in a fresh one. bubblewrap leaves the session's namespace descriptors open in what it
 * runs, and jig passes on whatever its own parent left open (a CI runner's pipes, an eval harness's): the
 * command, and the jobs it leaves running, inherit none of them. The command is this shell's $0, so what
 * follows it is still bash's $0 and "$@". (Closing a descriptor that isn't open, as /dev/fd's own is once
 * listed, does nothing.)
 */
const CLEAN_START = 'for fd in /dev/fd/*; do fd=${fd##*/}; case $fd in [3-9]|[1-9][0-9]*) eval "exec $fd<&-";; esac; done; exec /bin/bash -c "$0" "$@"';

/**
 * The Seatbelt profile: where commands can write, whether they reach the network, what they can't read.
 * `home` is jig's own directory, by its real path.
 */
export function seatbeltProfile(writable: string[], network: boolean, hidden: string[], git?: GitControl, home?: string): string {
  const denied = [...hidden, ...(home ? [home] : []), ...(git?.locked ?? [])]; // by path, in the rules below
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((dir) => `(subpath ${quote(dir)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...(network ? [] : ["(deny network-outbound (remote ip))", '(allow network-outbound (remote ip "localhost:*"))']),
    // Before git's rules, so that they hold in a project in jig's directory too.
    ...(home ? ownRules(home, writable) : []),
    // After the rule that lets the git directory be written, so they win over it. Unlike bubblewrap's, they
    // hold for files that aren't there yet. The directories holding them can't be moved aside either, or
    // others with files of the command's own could take their place.
    ...deny("file-write*", git?.locked.map((path) => `(${basename(path) === "hooks" ? "subpath" : "literal"} ${quote(path)})`)),
    ...deny("file-write-unlink", git?.fixed.map((dir) => `(literal ${quote(dir)})`)),
    // The hidden paths are denied by path, so the directories holding them in a writable one stay in place.
    ...deny("file-write-unlink", holding(hidden, writable).map((dir) => `(literal ${quote(dir)})`)),
    // And so do the writable directories holding them, jig's own or what git's lock lists (see writableHolding).
    ...deny("file-write-unlink", writableHolding(writable, denied).map((dir) => `(literal ${quote(dir)})`)),
    // Last, so that it wins over the rules before it: reading and writing alike.
    ...hidden.map((path) => `(deny file-read* file-write* (subpath ${quote(path)}))`),
  ].join("\n");
}

/**
 * Seatbelt's rules for jig's own directory, which holds copies of the files of every project jig worked
 * in: snapshots (with the hidden files in those older versions took), sessions, memories. So commands
 * can't read it, nor write in it where it lies in a writable directory (a temp directory, say), where
 * settings could add hooks, nor move it aside, or a directory holding it there (see ownFixed, and
 * writableHolding for the writable directory itself). Only its skills stay readable: the model runs their
 * scripts by their full path there, as the skill tool tells it, and nothing else in it is for commands. A
 * writable directory in it (a project that is a skill being written, say) stays as it was, and so does the
 * metadata of the directory itself, which resolving a path through it needs (realpath, as Node does for a
 * script it runs).
 */
function ownRules(home: string, writable: string[]): string[] {
  const inside = writable.filter((dir) => isInside(home, dir));
  return [
    `(deny file-read* file-write* (subpath ${quote(home)}))`,
    `(allow file-read-metadata (literal ${quote(home)}))`,
    `(allow file-read* (subpath ${quote(join(home, "skills"))}))`,
    ...(inside.length ? [`(allow file-read* file-write* ${inside.map((dir) => `(subpath ${quote(dir)})`).join(" ")})`] : []),
    ...deny("file-write-unlink", ownFixed(home, writable).map((dir) => `(literal ${quote(dir)})`)),
  ];
}

/**
 * bubblewrap's arguments for jig's own directory, as ownRules has it: the directories holding it that
 * ownFixed keeps in place bound once more, so they are mount points a command can't move aside, then an
 * empty directory over it (a mount point too), with its skills bound back in read-only, and then the
 * writable directories in it as they were. Worked out for each command, as the directory and its skills may
 * be made during the session.
 */
function ownBinds(home: string, writable: string[]): string[] {
  if (!existsSync(home)) return [];
  const skills = join(home, "skills");
  return [
    // Before the empty directory: bound after it, one would show what is under it again.
    ...ownFixed(home, writable).flatMap((dir) => ["--bind", dir, dir]),
    "--tmpfs", home,
    ...(existsSync(skills) ? ["--ro-bind", skills, skills] : []),
    ...writable.filter((dir) => isInside(home, dir)).flatMap((dir) => ["--bind", dir, dir]),
  ];
}

/**
 * The directories between jig's own and a writable directory it lies in (a temp directory, as in skill
 * evals and the tests), the outermost first. The sandbox hides jig's directory by its path, so a command
 * could move one of them aside, jig's directory with it, and read it at its new path in the next command,
 * whose sandbox hid what was at the old one instead (a directory the command made there, settings and all).
 * So they stay in place, as git's directories do (see controlOf), which grants nothing, as they lie in a
 * writable directory already; jig's directory itself can't be moved either way. A writable directory in
 * another (one added with --add-dir in a temp directory) counts as one between. ~/.jig has none: the home
 * directory can't be moved, even in a home-directory project.
 */
function ownFixed(home: string, writable: string[]): string[] {
  const fixed: string[] = [];
  for (let dir = dirname(home); writable.some((other) => other !== dir && isInside(other, dir)); dir = dirname(dir)) fixed.unshift(dir);
  return fixed;
}

/**
 * The directories between each hidden path and a writable directory it lies in, the outermost first, kept
 * in place as ownFixed has jig's: the sandbox hides a path by its path, so a command could move one aside,
 * the hidden path with it (config, holding config/.env), and read it at its new path in the next command.
 */
function holding(hidden: string[], writable: string[]): string[] {
  return [...new Set(hidden.flatMap((path) => ownFixed(path, writable)))].sort((a, b) => a.length - b.length);
}

/**
 * The writable directories holding any of `paths`, the outermost first, for Seatbelt to keep in place as it
 * keeps those between (see holding and ownFixed, which stop at a writable directory) and git's (see
 * keptInPlace): the (subpath ...) that lets commands write in one matches the directory itself too. So a
 * command could move the whole project to /private/tmp/p, make /p again, and read a hidden file at its new
 * path, or change git's config there and move the project back, as no rule names those paths. Only the
 * directory's own path is denied, so commands still make, remove and rename files and folders in it, as git
 * does in its git directory under the same rule. On Linux each writable directory is a mount point, which
 * can't be moved.
 */
function writableHolding(writable: string[], paths: string[]): string[] {
  return [...new Set(writable)].filter((dir) => paths.some((path) => isInside(dir, path))).sort((a, b) => a.length - b.length);
}

/**
 * A Seatbelt rule denying an operation on what the filters match, if there are any: with none, it would deny
 * it everywhere. A repository around a bare one may have no directories fixed (see aroundControl).
 */
function deny(operation: string, filters: string[] = []): string[] {
  return filters.length ? [`(deny ${operation} ${filters.join(" ")})`] : [];
}

/**
 * The file system read-only with the writable directories bound back in, and a fresh /dev. Without
 * `network`, each command gets a network namespace of its own: no internet and no servers on the
 * machine's ports, though a command can still use its own loopback. A server started in one command is
 * therefore out of reach of the next, unlike on macOS, where localhost stays open. A Unix socket is a
 * file, though, so a daemon listening on one (Docker's, say) stays within reach. Commands run in a PID
 * namespace of the session's own, with their own /proc, so they see only the session's processes, not
 * the machine's others, and can't reach the host's mount namespace through /proc/<pid>/root of a process
 * outside the sandbox (see Keeper). A job a command leaves in the background keeps running, reparented to
 * the namespace's init, until jig exits, when the kernel ends every process in the namespace.
 */
function bubblewrap(writable: string[], network: boolean, where: string, hidden: string[], git?: GitControl, home?: string, onFallback?: () => void): Sandbox {
  const bwrap = findProgram("bwrap")!;
  const keeper = new Keeper(bwrap, hidden, home, onFallback);
  // An empty directory over each hidden directory, and an empty file over each hidden file.
  const hiding = hidden.flatMap((path) => (statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]));
  // A bind of git's in jig's directory, outside the writable directories ownBinds shows there, or of one
  // holding it, would show it again (a .git a command made can lead anywhere): what is hidden there is out
  // of commands' reach anyway.
  const shown = (path: string) =>
    !home || (!isInside(path, home) && (!isInside(home, path) || writable.some((dir) => isInside(home, dir) && isInside(dir, path))));
  // Later mounts go over earlier ones: git's binds and the hidden paths hold in jig's directory too. --proc
  // mounts a fresh /proc for the session's PID namespace, so it shows only the session's processes.
  const args = (join: string[]) => [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    ...writable.flatMap((dir) => ["--bind", dir, dir]),
    // Mount points a command can't move aside (see holding), before jig's and git's binds: bound after
    // them, one would show what those cover again. Only what exists, as binding a path that doesn't fails.
    ...holding(hidden, writable).filter((dir) => existsSync(dir)).flatMap((dir) => ["--bind", dir, dir]),
    ...(home ? ownBinds(home, writable) : []),
    ...(git ? gitBinds(git, shown) : []),
    ...hiding,
    // Join the session's namespaces, or in the fallback --unshare-pid and --die-with-parent: if jig is killed,
    // so are its commands, which a joined one is with the keeper (see Keeper).
    ...join,
    ...(network ? [] : ["--unshare-net"]),
  ];
  const offline =
    ", and have no network: each command gets an empty one of its own, so it can't reach the internet, servers on this " +
    "machine's ports, or a server an earlier command started (start a server and use it in the same command)";
  const processes = " Commands see only this session's own processes, not the machine's others.";
  return {
    description: `bubblewrap sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : offline}${gitNote(git)}${hiddenNote(hidden)}${ownNote(home)}.${processes}`,
    wrap: (command) => {
      const { args: join, stdio, note, couldntJoin } = keeper.join();
      // bubblewrap leaves the namespace descriptors open in what it runs: CLEAN_START closes them.
      const run = ["/bin/bash", "-c", CLEAN_START];
      return { program: bwrap, args: [...args(join), "--", ...run, command], stdio: stdio.length ? stdio : undefined, note, couldntJoin };
    },
    close: () => keeper.close(),
  };
}

/**
 * One PID namespace per session, so each command's /proc shows only the session's processes and a command
 * can't step through /proc/<pid>/root of a process outside the sandbox (jig, the user's shell, anything of
 * the same user) into the host's mount namespace, where the sandbox's binds don't apply. bubblewrap runs
 * commands in the host's PID namespace, so without this a probe read a hidden file and wrote outside the
 * writable directories that way.
 *
 * The keeper is a small long-lived bubblewrap started once, lazily, at the first command, with --unshare-pid
 * (and, run unprivileged, the user namespace bwrap adds on its own). Each command then joins its namespaces
 * with --pidns (and --userns, which owns the PID namespace when unprivileged) and mounts its own /proc, so
 * it sees only the session's processes. A job a command leaves in the background is reparented to the
 * namespace's init and runs on for the session. The keeper is pid 1 of the namespace, so a command can reach
 * its root through /proc/1/root: the keeper mounts its own --proc /proc, so that root's /proc is the session's
 * too (not the host's, which would be a second hop /proc/1/root/proc/<hostpid>/root into the host's mount
 * namespace), and its root is read-only with the hidden paths and jig's directory masked, so reaching it
 * grants nothing: a command can already read every other path, and can't write through a read-only root. The
 * keeper's life is tied to jig's: it reads a pipe jig holds open, so jig's death sends it end-of-file, and
 * --die-with-parent kills it if jig is killed; either way its init ends and the kernel ends every process in
 * the namespace, the commands that joined it among them. (They don't take --die-with-parent themselves: given
 * it, any command that joined was now and then killed as it started, at random under load: bubblewrap sets it
 * just before it runs the command, whose parent can then still be a process of bubblewrap's that is exiting.
 * So a run that waits for its command, an eval's check say, kills it itself when bubblewrap is killed: see
 * execInSandbox.) A command can end the keeper too (kill -1 ends every process it may signal), and the
 * namespace with it, ending the session's jobs and any command running then. The next command starts another,
 * as the first did: jig sees the namespace's init or the keeper's shell gone, exiting or sent a signal that
 * ends it (see exited). Should the namespace end only after that, as bubblewrap joins it (a job can end it at
 * any time), bubblewrap can't join and starts nothing, which it lets jig know, and the command runs once more
 * in a new one (see join). A command that bubblewrap started never runs again. If bubblewrap is too old for
 * the join (no --pidns) or the keeper can't start, each command falls back to a PID namespace of its own
 * (--unshare-pid), which is as safe but ends a command's background jobs with the command; jig tells the user
 * so once, and the model, whom the bash tool tells to leave a server running in the background, with the first
 * command's result. jig never runs commands in the host's PID namespace. The keeper gets jig's environment
 * without its keys, as commands do: they can read its environment in /proc/1.
 */
class Keeper {
  private started = false;
  private told = false; // whether the model has heard of the fallback
  private child?: ChildProcess;
  private initPid = 0; // the namespace's init, its pid 1, by its pid outside it
  private userFd = -1;
  private pidFd = -1;
  private readonly bwrap: string;
  private readonly hidden: string[];
  private readonly home: string | undefined;
  private readonly onFallback?: () => void;

  constructor(bwrap: string, hidden: string[], home: string | undefined, onFallback?: () => void) {
    this.bwrap = bwrap;
    this.hidden = hidden;
    this.home = home;
    this.onFallback = onFallback;
  }

  /**
   * How a command joins the session's namespaces: the bubblewrap arguments and the descriptors they name, and
   * in the fallback, the first time, a note for the model.
   */
  join(): Pick<Wrapped, "note" | "couldntJoin"> & { args: string[]; stdio: (number | "pipe")[] } {
    // A command can end the keeper, and the namespace ends with it: joining that one would fail every later
    // command ("Can't fork for --pidns"), so start another, as at the first command.
    if (this.exited()) {
      this.close();
      this.started = false;
    }
    this.ensure();
    if (this.pidFd < 0) {
      // The fallback: a PID namespace per command, which ends with jig only by --die-with-parent.
      const note = this.told ? undefined : PER_COMMAND;
      this.told = true;
      return { args: ["--unshare-pid", "--die-with-parent"], stdio: [], note };
    }
    const fds = this.userFd >= 0 ? [this.userFd, this.pidFd] : [this.pidFd];
    const args = this.userFd >= 0 ? ["--userns", "3", "--pidns", "4"] : ["--pidns", "3"];
    // The namespace can still end as bubblewrap joins it, by a job, say: bubblewrap then can't join ("Can't
    // fork for --pidns", "Unexpected short read from pid socket") and starts nothing. It reports the command's
    // process on the pipe once it has joined, before it lets the command start: so a run that reported nothing,
    // in a namespace that has since ended, started nothing, and runs once more in a new one.
    const joined = this.child;
    const couldntJoin = (reported: string) => !reported && (this.child !== joined || this.exited());
    return { args: [...args, "--info-fd", String(3 + fds.length)], stdio: [...fds, "pipe"], couldntJoin };
  }

  private ensure(): void {
    if (this.started) return;
    this.started = true;
    try {
      if (!this.start()) throw new Error("the keeper's namespaces can't be joined");
    } catch {
      this.close();
      this.onFallback?.();
    }
  }

  /** Starts the keeper and verifies a command can join it; false (or a throw) means fall back. */
  private start(): boolean {
    if (!keeperSupported(this.bwrap)) return false;
    const infoPath = join(tmpdir(), `jig-keeper-${randomBytes(6).toString("hex")}`);
    let infoFd: number | undefined = openSync(infoPath, "wx", 0o600);
    try {
      // The keeper is pid 1 of the session's namespace, so a command can reach its root through /proc/1/root.
      // It mounts its own --proc /proc (it has --unshare-pid) so that root's /proc is the session's, not the
      // host's: without it, /proc/1/root/proc/<hostpid>/root was a second hop into the host's mount namespace,
      // where the sandbox's binds don't apply -- the very escape this closes. keeperHiding masks the hidden
      // paths and jig's directory in the root, so reaching it directly through /proc/1/root grants nothing.
      // Its shell says it runs, after bwrap's report in the same file (see keeperChildPid), and closes its output.
      const shell = `echo ${KEEPER_RUNNING}; exec >&-; read x`;
      const args = ["--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", ...keeperHiding(this.hidden, this.home), "--info-fd", "3", "--", "/bin/sh", "-c", shell];
      // Detached, so the terminal's Ctrl+C doesn't reach it: the session goes on after an interrupted command.
      // Its stdin is a pipe jig holds open; jig's death closes it, and the keeper's `read` then ends. Without
      // jig's keys, as commands get: they share its PID namespace and can read its environment in /proc/1.
      this.child = spawn(this.bwrap, args, { env: withoutKeys(), stdio: ["pipe", infoFd, "ignore", infoFd], detached: true });
      this.child.unref();
      this.child.stdin?.on("error", () => {}); // the write end can outlive the keeper; ignore EPIPE
      closeSync(infoFd);
      infoFd = undefined;
      const childPid = keeperChildPid(infoPath);
      if (childPid === undefined) return false;
      this.initPid = childPid;
      this.pidFd = openSync(`/proc/${childPid}/ns/pid`, "r");
      // Run unprivileged, bwrap gave the keeper a user namespace of its own, which owns the PID one; a
      // command joins both. Run as root, the keeper stays in the host user namespace, so there is none to join.
      if (readlinkSync(`/proc/${childPid}/ns/user`) !== readlinkSync("/proc/self/ns/user")) this.userFd = openSync(`/proc/${childPid}/ns/user`, "r");
      return probeJoin(this.bwrap, this.userFd, this.pidFd);
    } finally {
      if (infoFd !== undefined) try { closeSync(infoFd); } catch {} // the spawn failed
      try { rmSync(infoPath, { force: true }); } catch {}
    }
  }

  /** Whether Node has seen the keeper's bubblewrap exit. */
  private ended(): boolean {
    return !!this.child && (this.child.exitCode !== null || this.child.signalCode !== null);
  }

  /**
   * Whether the session's namespace has ended, or is ending. Node sees the keeper exit only on a later turn
   * of its event loop, which can come after the end of the command that ended it, so the namespace's init is
   * asked too, and the keeper's shell, its pid 2, as the keeper's own /proc shows it: a command that killed it
   * can exit before it has, and before the init has seen it, and the next command would then join a
   * namespace about to end, to be ended with it.
   */
  private exited(): boolean {
    if (!this.child || !this.initPid) return false;
    return this.ended() || ending(`/proc/${this.initPid}`) || ending(`/proc/${this.initPid}/root/proc/2`);
  }

  /** Ends the keeper and the whole session's namespace, and frees the descriptors jig held open. */
  close(): void {
    try { this.child?.stdin?.destroy(); } catch {}
    if (this.child?.pid && !this.ended()) try { process.kill(-this.child.pid, "SIGKILL"); } catch {} // a pid can be reused once it has exited
    for (const fd of [this.userFd, this.pidFd]) if (fd >= 0) try { closeSync(fd); } catch {}
    this.userFd = this.pidFd = -1;
    this.initPid = 0;
    this.child = undefined;
  }
}

/**
 * Whether the process with this /proc directory has gone, is exiting (PF_EXITING in its flags, set before
 * the kernel ends a namespace's processes with its init), or has a signal pending that ends it: one it
 * doesn't block, catch or ignore, and that ends a process. The kernel marks it so as the signal is sent, but
 * the process exits only once it runs, which under load can be a while. Where /proc won't say, it isn't.
 */
function ending(dir: string): boolean {
  let stat: string, status: string;
  try {
    stat = readFileSync(join(dir, "stat"), "utf8");
    status = readFileSync(join(dir, "status"), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"; // reaped
  }
  const [state, , , , , , flags] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (state === "Z" || state === "X" || (Number(flags) & PF_EXITING) !== 0) return true;
  const mask = (field: string) => BigInt(`0x${new RegExp(`^${field}:\\s*([0-9a-f]+)$`, "m").exec(status)?.[1] ?? "0"}`);
  const spared = mask("SigBlk") | mask("SigCgt") | mask("SigIgn") | NOT_ENDING;
  return ((mask("SigPnd") | mask("ShdPnd")) & ~spared) !== 0n;
}

const KEEPER_START_MS = 5000; // how long to wait for the keeper to report its PID before falling back
const KEEPER_RUNNING = "running"; // what the keeper's shell says once it runs
const PF_EXITING = 0x4; // in a process's flags in /proc/<pid>/stat: it has begun to exit
// The signals that by default leave a process running, as bits of /proc/<pid>/status's masks.
const NOT_ENDING = (["SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGWINCH"] as const).reduce(
  (bits, name) => bits | (1n << BigInt(osConstants.signals[name] - 1)),
  0n,
);
const PER_COMMAND =
  "(Each command here runs in a process namespace of its own, so a job it leaves in the background ends with it: " +
  "start a server and use it in the same command.)";

/** Whether this bubblewrap offers what the keeper and the join need (an old one, before --pidns, doesn't). */
function keeperSupported(bwrap: string): boolean {
  try {
    const help = execFileSync(bwrap, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    return ["--pidns", "--userns", "--info-fd"].every((flag) => help.includes(flag));
  } catch {
    return false;
  }
}

/**
 * The PID of the keeper's init, read from the --info-fd file bwrap writes early, once the keeper's shell has
 * said in it that it runs: it is the namespace's process 2 then, as nothing else can be in the namespace before
 * jig has it (see Keeper.exited). Undefined if that never comes (it failed to start).
 */
function keeperChildPid(infoPath: string): number | undefined {
  const deadline = Date.now() + KEEPER_START_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      const pid = new RegExp(`"child-pid":\\s*(\\d+)[^]*\\n${KEEPER_RUNNING}\\n`).exec(readFileSync(infoPath, "utf8"))?.[1];
      if (pid) return Number(pid);
    } catch {
      // not written yet
    }
    Atomics.wait(sleeper, 0, 0, 10); // a short sync wait, so startup doesn't busy-loop
  }
  return undefined;
}

/** That a command can actually join the keeper's namespaces: as root it can, and unprivileged it can where the kernel allows it. */
function probeJoin(bwrap: string, userFd: number, pidFd: number): boolean {
  const { args, stdio } = userFd >= 0 ? { args: ["--userns", "3", "--pidns", "4"], stdio: [userFd, pidFd] } : { args: ["--pidns", "3"], stdio: [pidFd] };
  try {
    execFileSync(bwrap, [...args, "--ro-bind", "/", "/", "--proc", "/proc", "--", "/bin/true"], {
      stdio: ["ignore", "ignore", "ignore", ...stdio],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * How the keeper masks what a command masks, so its read-only root is no way around the sandbox: an empty
 * directory over each hidden directory, /dev/null over each hidden file, and an empty directory over jig's
 * own directory (its skills aren't needed here, only in commands). Only over what is there, since the
 * keeper's root is read-only and a bind of a missing path would fail.
 */
function keeperHiding(hidden: string[], home: string | undefined): string[] {
  const out = hidden.flatMap((path) => {
    try {
      return statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
    } catch {
      return [];
    }
  });
  if (home && existsSync(home)) out.push("--tmpfs", home);
  return out;
}

/**
 * bubblewrap's arguments for what gitControl found, of what is `shown`, worked out for each command: binding a
 * path that is no longer there fails the command, and the user may remove a worktree or a submodule during the
 * session.
 */
function gitBinds({ locked, fixed }: GitControl, shown: (path: string) => boolean): string[] {
  // A hooks directory that isn't there is made, empty as git's default one, so that it can be bound read-only.
  for (const path of locked) {
    if (basename(path) !== "hooks" || existsSync(path)) continue;
    try {
      mkdirSync(path);
    } catch {
      // If jig can't, commands, which run as the same user, can't either; nor where its git directory is gone.
    }
  }
  // The git directory, those between it and what is locked, and those between them and a writable directory
  // they lie in (see keptInPlace) bound once more, so they are mount points a command can't move aside. A
  // directory bound before in one of the last (holding a hidden path, see holding) stays in place too: a mount
  // on a directory keeps it from being moved, whatever is bound later over one holding it. Then what is
  // locked, read-only. Only what exists: binding a path that doesn't would create it (gitWatch looks out for
  // those).
  return [
    ...fixed.filter((dir) => shown(dir) && existsSync(dir)).flatMap((dir) => ["--bind", dir, dir]),
    ...locked.filter((path) => shown(path) && existsSync(path)).flatMap((path) => ["--ro-bind", path, path]),
  ];
}

/** For the model: why changing the git config or a hook fails. */
function gitNote(git?: GitControl): string {
  if (!git) return "";
  // A server's bare repository is left writable: only what the repository around it has here is locked.
  return git.aroundOnly
    ? ". Some git files of the repository around this one are read-only (a submodule checkout's .git, say): if one needs changing, ask the user"
    : ". The repository's git config and hooks are read-only, its submodules' too: if one needs changing, ask the user";
}

/** For the model: that some paths are hidden, so their denials make sense (not which: they may be answers). */
function hiddenNote(hidden: string[]): string {
  return hidden.length ? ". Some paths are hidden from commands by the user's settings" : "";
}

/** For the model: that jig's own directory is hidden too (not where it is: a benchmark keeps it with its logs). */
function ownNote(home?: string): string {
  return home ? ". jig's own directory (its sessions, snapshots and settings) is hidden from commands, but for its skills" : "";
}

let bubblewrapProblem: string | undefined;

/**
 * bubblewrap needs to be installed and allowed to create user namespaces, and to mount a /proc for a PID
 * namespace, which every command does (see Keeper): in a container that masks parts of its own /proc, as
 * Docker and Podman do unless told not to, the kernel refuses it. Try it once.
 */
function checkBubblewrap(): string {
  const bwrap = findProgram("bwrap");
  if (!bwrap) return "bubblewrap isn't installed (on Debian or Ubuntu: sudo apt install bubblewrap)";
  try {
    const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--", "/bin/true"];
    execFileSync(bwrap, args, { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
    return "";
  } catch (err) {
    const reason = String((err as { stderr?: Buffer }).stderr ?? "").trim().split("\n")[0] || (err as Error).message;
    return `bubblewrap can't create a sandbox here: ${reason.replace(/^bwrap: /, "").replace(/\.$/, "")}`;
  }
}

function findProgram(name: string): string | undefined {
  return (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name)).find((path) => existsSync(path));
}

/**
 * The repository's git directories: the common one, which may be outside the project (jig started in a
 * subdirectory, or in a linked worktree), and the work tree's own. Those the nearest .git leads to, in
 * the project or above it, whether git takes them for a repository now or not: it doesn't while their
 * HEAD, objects or refs are out of order, which commands can arrange, as git changes them all the time.
 * Asking git, a session after one whose command moved .git/HEAD aside would lock nothing, and a command in
 * it could change the config and put the HEAD back. The walk stops where git's does: at a bare repository,
 * a git directory whose config says it is bare, which has no .git (looked for after the .git, as git does,
 * so a config a command writes beside a .git hides nothing), and below GIT_CEILING_DIRECTORIES. Going on,
 * it took a home directory's dotfiles repository for that of a bare repository in it, or of a project the
 * user had told git to keep apart, and let commands write in it. A config alone, which git takes for no
 * repository, doesn't stop it: written by a command in a subdirectory of a repository, it had the next
 * session there lock nothing. git is asked where the walk finds nothing, or a .git that leads to no git
 * directory (git passes over an empty .git directory).
 */
function gitDirs(project: string): GitDirs | undefined {
  const ceilings = gitCeilings();
  for (let dir = project; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      const found = gitDirsOf(dotGit);
      return found ? { ...found, bare: isBare(join(found.common, "config")) } : gitDirsFromGit(project);
    }
    if (isGitDirectory(dir) && isBare(join(dir, "config"))) {
      const real = realpathSync(dir);
      return { common: real, own: real, bare: true, tree: real };
    }
    if (dirname(dir) === dir || ceilings.includes(dirname(dir))) return gitDirsFromGit(project);
  }
}

/**
 * GIT_CEILING_DIRECTORIES, the directories git doesn't go up into to look for a repository: as git takes
 * them, those that are absolute and there, by real path.
 */
function gitCeilings(): string[] {
  return (process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter).filter((dir) => isAbsolute(dir)).flatMap((dir) => {
    try {
      return [realpathSync(dir)];
    } catch {
      return [];
    }
  });
}

/**
 * The git directories a .git leads to, if they are a repository's: if the common one has a config, which
 * is locked and so stays, or the work tree's own has a HEAD. A .git file names the work tree's own git
 * directory, relative to where it is (a linked worktree's or a submodule checkout's), and that one's
 * commondir names the common one. Whether it is bare is left to gitDirs: asking git costs a few
 * milliseconds, and the repositories around the project's don't need it.
 */
function gitDirsOf(dotGit: string): Found | undefined {
  try {
    let own = dotGit;
    if (!statSync(dotGit).isDirectory()) {
      const named = /^gitdir: (.+)/.exec(readRegularFile(dotGit, GIT_FILE_BYTES) ?? "")?.[1];
      if (named === undefined) return undefined;
      own = resolve(dirname(dotGit), named.trimEnd());
    }
    own = realpathSync(own);
    const commondir = readRegularFile(join(own, "commondir"), GIT_FILE_BYTES);
    const common = commondir === undefined ? own : realpathSync(resolve(own, commondir.trimEnd()));
    if (!existsSync(join(common, "config")) && !existsSync(join(own, "HEAD"))) return undefined;
    return { common, own, tree: dirname(dotGit) };
  } catch {
    return undefined; // a git directory that isn't there, or a link to itself (ELOOP)
  }
}

/**
 * Whether a git directory's config says it is bare (a bare clone a .git file names, say), as git rev-parse
 * would. The config is the one the sandbox locks, unless the repository is bare, so commands can't make a
 * repository bare to have its lock dropped.
 */
function isBare(config: string): boolean {
  try {
    if (!statSync(config).isFile()) return false; // git would wait on a named pipe
    const args = [...SAFE_GIT, "config", "--file", config, "--type=bool", "--get", "core.bare"];
    return execFileSync("git", args, { env: withoutKeys(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false; // no config, or no core.bare in it
  }
}

/** The git directories git itself finds from the project. */
function gitDirsFromGit(project: string): GitDirs | undefined {
  try {
    // The paths come relative to the project unless they are elsewhere: --path-format=absolute would make
    // them absolute, but a git before 2.31 (Debian 11 has 2.30) prints it back as if it were a path.
    const out = execFileSync("git", [...SAFE_GIT, "rev-parse", "--is-bare-repository", "--git-common-dir", "--git-dir"], {
      cwd: project,
      env: withoutKeys(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [bare, ...dirs] = out.trim().split("\n");
    const [common, own] = dirs.map((dir) => realpathSync(resolve(project, dir)));
    return { common, own, bare: bare === "true" };
  } catch {
    return undefined;
  }
}

/** A string literal for a Seatbelt profile. */
function quote(path: string): string {
  return `"${path.replace(/[\\"]/g, "\\$&")}"`;
}
