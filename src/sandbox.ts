import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isGitControl, isInside, SAFE_GIT, withoutKeys } from "./tools/util.ts";

/** Where commands run when jig contains them (see createSandbox). */
export interface Sandbox {
  /** For the user, e.g. "macOS sandbox, no network". */
  description: string;
  /** For the model: what commands can't do. */
  limits: string;
  /** The program and arguments that run `command` in bash inside the sandbox. */
  wrap(command: string): { program: string; args: string[] };
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Commands run in the operating system's own sandbox, the way Codex and Claude Code sandbox them:
 * Seatbelt on macOS, bubblewrap on Linux. Either way they can read anything, but write only inside the
 * project, its git directory (not its config or hooks), the directories added with --add-dir and the
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
  const git = gitDir(project);
  const writable = [project, git, ...added, realpathSync(tmpdir()), ...temp].filter(
    (dir, i, all): dir is string => !!dir && !all.slice(0, i).some((other) => other && isInside(other, dir)),
  );
  const where = `inside the project${added.length ? `, ${added.join(", ")}` : ""} and the temp directories`;
  // git runs the programs a repository's config and hooks name, outside the sandbox: the user's git after
  // the session (a shell prompt may run it at every line), and jig's own if jig didn't turn them off. So
  // commands can't change them. A bare repository's are left alone, as the file tools leave them: setting
  // up a server's hooks can be the task.
  const guarded = git && isGitControl(join(git, "config")) ? git : undefined;
  return process.platform === "darwin"
    ? seatbelt(writable, network, where, unreadable, guarded)
    : bubblewrap(writable, network, where, unreadable, guarded);
}

/** Why there is no sandbox on this machine, or undefined if there is one. */
export function sandboxProblem(): string | undefined {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? undefined : `${SANDBOX_EXEC} is missing`;
  if (process.platform === "linux") return (bubblewrapProblem ??= checkBubblewrap()) || undefined;
  return `jig has no sandbox for ${process.platform} yet`;
}

function seatbelt(writable: string[], network: boolean, where: string, hidden: string[], git?: string): Sandbox {
  const profile = seatbeltProfile(writable, network, hidden, git);
  return {
    description: `macOS sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : ", and can't use the network except localhost"}${gitNote(git)}${hiddenNote(hidden)}.`,
    wrap: (command) => ({ program: SANDBOX_EXEC, args: ["-p", profile, "/bin/bash", "-c", command] }),
  };
}

/** The Seatbelt profile: where commands can write, whether they reach the network, what they can't read. */
export function seatbeltProfile(writable: string[], network: boolean, hidden: string[], git?: string): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((dir) => `(subpath ${quote(dir)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...(network ? [] : ["(deny network-outbound (remote ip))", '(allow network-outbound (remote ip "localhost:*"))']),
    // After the rule that lets the git directory be written, so they win over it. The directory itself
    // can't be moved aside either, or another with a config of the command's own could take its place.
    ...(git
      ? [
          `(deny file-write* (literal ${quote(join(git, "config"))}) (subpath ${quote(join(git, "hooks"))}))`,
          `(deny file-write-unlink (literal ${quote(git)}))`,
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
function bubblewrap(writable: string[], network: boolean, where: string, hidden: string[], git?: string): Sandbox {
  const bwrap = findProgram("bwrap")!;
  // The git directory bound once more, so it is a mount point a command can't move aside, then its config
  // and hooks read-only: those that exist, since binding a path that doesn't would create it.
  const locked = git ? [join(git, "config"), join(git, "hooks")].filter((path) => existsSync(path)) : [];
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    ...writable.flatMap((dir) => ["--bind", dir, dir]),
    ...(git ? ["--bind", git, git] : []),
    ...locked.flatMap((path) => ["--ro-bind", path, path]),
    // An empty directory over each hidden directory, and an empty file over each hidden file.
    ...hidden.flatMap((path) => (statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path])),
    ...(network ? [] : ["--unshare-net"]),
    "--die-with-parent", // if jig is killed, so are its commands
  ];
  const offline =
    ", and have no network: each command gets an empty one of its own, so it can't reach the internet, servers on this " +
    "machine's ports, or a server an earlier command started (start a server and use it in the same command)";
  return {
    description: `bubblewrap sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : offline}${gitNote(git)}${hiddenNote(hidden)}.`,
    wrap: (command) => ({ program: bwrap, args: [...args, "--", "/bin/bash", "-c", command] }),
  };
}

/** For the model: why changing the git config or a hook fails. */
function gitNote(git?: string): string {
  return git ? ". The repository's git config and hooks are read-only: if one needs changing, ask the user" : "";
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

/** The repository's git directory when it is outside the project (jig started in a subdirectory). */
function gitDir(project: string): string | undefined {
  try {
    const dir = execFileSync("git", [...SAFE_GIT, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: project,
      env: withoutKeys(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return realpathSync(dir);
  } catch {
    return undefined;
  }
}

/** A string literal for a Seatbelt profile. */
function quote(path: string): string {
  return `"${path.replace(/[\\"]/g, "\\$&")}"`;
}
