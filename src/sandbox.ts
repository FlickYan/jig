import { execFileSync } from "node:child_process";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { isGitControl, isInside, readRegularFile, SAFE_GIT, withoutKeys } from "./tools/util.ts";

/** Where commands run when jig contains them (see createSandbox). */
export interface Sandbox {
  /** For the user, e.g. "macOS sandbox, no network". */
  description: string;
  /** For the model: what commands can't do. */
  limits: string;
  /** The program and arguments that run `command` in bash inside the sandbox. */
  wrap(command: string): { program: string; args: string[] };
  /**
   * Those of the files telling git where its config is that commands created or changed since the last call.
   * On Linux the sandbox can't keep a missing one from being created, and neither sandbox refuses a .git made
   * in the project when jig runs in a subdirectory of the repository (see gitWatch), so jig says so after a task.
   */
  gitChanges?(): string[];
}

/** What the sandbox keeps commands from changing in a repository (see gitControl). */
export interface GitControl {
  /** Config, hooks and the files that say where they are, whether they exist or not. */
  locked: string[];
  /** The git directory and the directories between it and those, which can't be moved aside either. */
  fixed: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const GIT_FILE_BYTES = 65_536; // read of a file that tells git where things are: it holds a path, or a little config

/**
 * Commands run in the operating system's own sandbox, the way Codex and Claude Code sandbox them:
 * Seatbelt on macOS, bubblewrap on Linux. Either way they can read anything, but write only inside the
 * project, its git directory (not what gitControl lists), the directories added with --add-dir and the
 * temp directories, and without `network` they have no IP network (Unix sockets stay open). Unlike a
 * container, this keeps the user's own toolchain (python, node, compilers) working with no setup. The
 * `hidden` paths they can't read at all. Returns undefined where there is no sandbox; sandboxProblem says why.
 */
export function createSandbox(root: string, { network, dirs = [], hidden = [] }: { network: boolean; dirs?: string[]; hidden?: string[] }): Sandbox | undefined {
  if (sandboxProblem()) return undefined;
  const project = realpathSync(root); // Seatbelt sees real paths: /var is /private/var
  const unreadable = hidden.filter((path) => existsSync(path)).map((path) => realpathSync(path));
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
  const guarded = gitControl(project, repo);
  const sandbox =
    process.platform === "darwin"
      ? seatbelt(writable, network, where, unreadable, guarded)
      : bubblewrap(writable, network, where, unreadable, guarded);
  return guarded ? { ...sandbox, gitChanges: gitWatch(guarded, project) } : sandbox;
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
 */
export function gitControl(project: string, repo = gitDirs(project)): GitControl | undefined {
  if (!repo || (repo.bare && !worktrees(repo.common).length && !isGitControl(join(repo.common, "config")))) return undefined;
  const { common, own } = repo;
  const inGitDir = (dir: string) => [
    ...["config", "config.worktree", "commondir", "hooks"].map((name) => join(dir, name)),
    ...worktrees(dir).flatMap((tree) => ["commondir", "gitdir", "config.worktree"].map((name) => join(tree, name))),
  ];
  // A linked worktree's submodules have their git directories in its own (worktrees/<name>/modules).
  const modules = [...new Set([common, own, ...worktrees(common)])].flatMap((dir) => submodules(join(dir, "modules")));
  const dotGits = [dotGitFile(project), ...worktrees(common).map(worktreeDotGit), ...modules.map(checkoutDotGit)];
  const locked = [...[common, ...modules].flatMap(inGitDir), ...new Set(dotGits.filter((path) => path !== undefined))];
  // Moved aside, a directory holding them could be replaced by one with files of a command's own.
  const fixed = new Set([common]);
  for (const path of locked) {
    for (let dir = dirname(path); dir !== common && isInside(common, dir); dir = dirname(dir)) fixed.add(dir);
  }
  return { locked, fixed: [...fixed].sort((a, b) => a.length - b.length) }; // a directory before those in it
}

/** The git directories of submodules under a modules directory: by name, which can hold slashes, and theirs. */
function submodules(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return existsSync(join(path, "HEAD")) ? [path, ...submodules(join(path, "modules"))] : submodules(path);
    });
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
 * A submodule checkout's .git file, from where the submodule's config says its checkout is (core.worktree,
 * relative to its git directory). The user's git status in the superproject runs git in the checkout,
 * so a .git file there pointing elsewhere would have it run a config of a command's own.
 */
function checkoutDotGit(module: string): string | undefined {
  try {
    // git would wait on a config that is a named pipe, as a command can leave in a submodule's directory it
    // made. Inside the try, as a link to itself there makes stat throw (ELOOP).
    if (!statSync(join(module, "config")).isFile()) return undefined;
    const args = [...SAFE_GIT, "config", "--file", join(module, "config"), "--get", "core.worktree"];
    const tree = execFileSync("git", args, { env: withoutKeys(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return dotGitIn(resolve(module, tree.replace(/\n$/, "")));
  } catch {
    return undefined; // no config to read, no checkout, or one git doesn't know of
  }
}

/** A work tree's .git by its real path (Seatbelt sees no other), unless it is a directory: then it is a repository of its own. */
function dotGitIn(tree: string): string | undefined {
  const path = join(existsSync(tree) ? realpathSync(tree) : tree, ".git");
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? undefined : path;
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
 * the project is reported too: the user's git there would then take its config from where that leads.
 * Neither sandbox refuses it, since making a repository there (git init) can be the task.
 */
function gitWatch({ locked }: GitControl, project: string): () => string[] {
  const dotGit = join(project, ".git"); // if there is none, jig runs in a subdirectory of the repository
  const watched = [...new Set([...locked, ...(existsSync(dotGit) ? [] : [dotGit])])].filter(
    (path) => basename(path) === ".git" || (basename(path) !== "hooks" && !existsSync(path)),
  );
  const seen = new Map(watched.map((path) => [path, contents(path)]));
  return () =>
    watched.filter((path) => {
      const now = contents(path);
      if (now === undefined || now === seen.get(path)) return false;
      seen.set(path, now);
      return true;
    });
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

function seatbelt(writable: string[], network: boolean, where: string, hidden: string[], git?: GitControl): Sandbox {
  const profile = seatbeltProfile(writable, network, hidden, git);
  return {
    description: `macOS sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : ", and can't use the network except localhost"}${gitNote(git)}${hiddenNote(hidden)}.`,
    wrap: (command) => ({ program: SANDBOX_EXEC, args: ["-p", profile, "/bin/bash", "-c", command] }),
  };
}

/** The Seatbelt profile: where commands can write, whether they reach the network, what they can't read. */
export function seatbeltProfile(writable: string[], network: boolean, hidden: string[], git?: GitControl): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((dir) => `(subpath ${quote(dir)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...(network ? [] : ["(deny network-outbound (remote ip))", '(allow network-outbound (remote ip "localhost:*"))']),
    // After the rule that lets the git directory be written, so they win over it. Unlike bubblewrap's, they
    // hold for files that aren't there yet. The directories holding them can't be moved aside either, or
    // others with files of the command's own could take their place.
    ...(git
      ? [
          `(deny file-write* ${git.locked.map((path) => `(${basename(path) === "hooks" ? "subpath" : "literal"} ${quote(path)})`).join(" ")})`,
          `(deny file-write-unlink ${git.fixed.map((dir) => `(literal ${quote(dir)})`).join(" ")})`,
        ]
      : []),
    // Last, so that it wins over the rules before it: reading and writing alike.
    ...hidden.map((path) => `(deny file-read* file-write* (subpath ${quote(path)}))`),
  ].join("\n");
}

/**
 * The file system read-only with the writable directories bound back in, and a fresh /dev. Without
 * `network`, each command gets a network namespace of its own: no internet and no servers on the
 * machine's ports, though a command can still use its own loopback. A server started in one command is
 * therefore out of reach of the next, unlike on macOS, where localhost stays open. A Unix socket is a
 * file, though, so a daemon listening on one (Docker's, say) stays within reach. Commands also share the
 * machine's process IDs, and can signal the user's other processes: in a PID namespace of their own, a
 * job a command leaves running in the background would die with its shell.
 */
function bubblewrap(writable: string[], network: boolean, where: string, hidden: string[], git?: GitControl): Sandbox {
  const bwrap = findProgram("bwrap")!;
  // An empty directory over each hidden directory, and an empty file over each hidden file.
  const hiding = hidden.flatMap((path) => (statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]));
  const args = () => [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    ...writable.flatMap((dir) => ["--bind", dir, dir]),
    ...(git ? gitBinds(git) : []),
    ...hiding,
    ...(network ? [] : ["--unshare-net"]),
    "--die-with-parent", // if jig is killed, so are its commands
  ];
  const offline =
    ", and have no network: each command gets an empty one of its own, so it can't reach the internet, servers on this " +
    "machine's ports, or a server an earlier command started (start a server and use it in the same command)";
  return {
    description: `bubblewrap sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : offline}${gitNote(git)}${hiddenNote(hidden)}.`,
    wrap: (command) => ({ program: bwrap, args: [...args(), "--", "/bin/bash", "-c", command] }),
  };
}

/**
 * bubblewrap's arguments for what gitControl found, worked out for each command: binding a path that is no
 * longer there fails the command, and the user may remove a worktree or a submodule during the session.
 */
function gitBinds({ locked, fixed }: GitControl): string[] {
  // A hooks directory that isn't there is made, empty as git's default one, so that it can be bound read-only.
  for (const path of locked) {
    if (basename(path) !== "hooks" || existsSync(path)) continue;
    try {
      mkdirSync(path);
    } catch {
      // If jig can't, commands, which run as the same user, can't either; nor where its git directory is gone.
    }
  }
  // The git directory and those between it and what is locked bound once more, so they are mount points a
  // command can't move aside; then what is locked, read-only. Only what exists: binding a path that doesn't
  // would create it (gitWatch looks out for those).
  return [
    ...fixed.filter((dir) => existsSync(dir)).flatMap((dir) => ["--bind", dir, dir]),
    ...locked.filter((path) => existsSync(path)).flatMap((path) => ["--ro-bind", path, path]),
  ];
}

/** For the model: why changing the git config or a hook fails. */
function gitNote(git?: GitControl): string {
  return git ? ". The repository's git config and hooks are read-only, its submodules' too: if one needs changing, ask the user" : "";
}

/** For the model: that some paths are hidden, so their denials make sense (not which: they may be answers). */
function hiddenNote(hidden: string[]): string {
  return hidden.length ? ". Some paths are hidden from commands by the user's settings" : "";
}

let bubblewrapProblem: string | undefined;

/** bubblewrap needs to be installed and allowed to create user namespaces; try it once. */
function checkBubblewrap(): string {
  const bwrap = findProgram("bwrap");
  if (!bwrap) return "bubblewrap isn't installed (on Debian or Ubuntu: sudo apt install bubblewrap)";
  try {
    execFileSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--", "/bin/true"], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
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
 * subdirectory, or in a linked worktree), and the work tree's own (a linked worktree's, under the common
 * one's worktrees/), and whether the repository is bare rather than one with a work tree.
 */
function gitDirs(project: string): { common: string; own: string; bare: boolean } | undefined {
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
