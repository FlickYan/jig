import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isInside } from "./tools/util.ts";

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
 * project, its git directory, the directories added with --add-dir and the temp directories, and without
 * `network` they can't reach the network. Unlike a container, this keeps the user's own toolchain
 * (python, node, compilers) working with no setup.
 * Returns undefined where there is no sandbox; sandboxProblem says why.
 */
export function createSandbox(root: string, { network, dirs = [] }: { network: boolean; dirs?: string[] }): Sandbox | undefined {
  if (sandboxProblem()) return undefined;
  const project = realpathSync(root); // Seatbelt sees real paths: /var is /private/var
  const added = dirs.map((dir) => realpathSync(dir));
  const temp = process.platform === "darwin" ? ["/private/tmp"] : ["/tmp", "/var/tmp"].filter((dir) => existsSync(dir));
  const writable = [project, gitDir(project), ...added, realpathSync(tmpdir()), ...temp].filter(
    (dir, i, all): dir is string => !!dir && !all.slice(0, i).some((other) => other && isInside(other, dir)),
  );
  const where = `inside the project${added.length ? `, ${added.join(", ")}` : ""} and the temp directories`;
  return process.platform === "darwin" ? seatbelt(writable, network, where) : bubblewrap(writable, network, where);
}

/** Why there is no sandbox on this machine, or undefined if there is one. */
export function sandboxProblem(): string | undefined {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? undefined : `${SANDBOX_EXEC} is missing`;
  if (process.platform === "linux") return (bubblewrapProblem ??= checkBubblewrap()) || undefined;
  return `jig has no sandbox for ${process.platform} yet`;
}

function seatbelt(writable: string[], network: boolean, where: string): Sandbox {
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((dir) => `(subpath ${quote(dir)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...(network ? [] : ["(deny network-outbound (remote ip))", '(allow network-outbound (remote ip "localhost:*"))']),
  ].join("\n");
  return {
    description: `macOS sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : ", and can't use the network except localhost"}.`,
    wrap: (command) => ({ program: SANDBOX_EXEC, args: ["-p", profile, "/bin/bash", "-c", command] }),
  };
}

/**
 * The file system read-only with the writable directories bound back in, and a fresh /dev. Without
 * `network`, each command gets a network namespace of its own: no internet and no servers on the
 * machine, though a command can still use its own loopback. A server started in one command is
 * therefore out of reach of the next, unlike on macOS, where localhost stays open.
 */
function bubblewrap(writable: string[], network: boolean, where: string): Sandbox {
  const bwrap = findProgram("bwrap")!;
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    ...writable.flatMap((dir) => ["--bind", dir, dir]),
    ...(network ? [] : ["--unshare-net"]),
    "--die-with-parent", // if jig is killed, so are its commands
  ];
  const offline =
    ", and have no network: each command gets an empty one of its own, so it can't reach the internet, this machine's " +
    "servers, or a server an earlier command started (start a server and use it in the same command)";
  return {
    description: `bubblewrap sandbox${network ? "" : ", no network"}`,
    limits: `Commands can write only ${where}${network ? "" : offline}.`,
    wrap: (command) => ({ program: bwrap, args: [...args, "--", "/bin/bash", "-c", command] }),
  };
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
    const dir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: project,
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
