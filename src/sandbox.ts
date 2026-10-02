import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * Commands run under macOS's built-in sandbox (Seatbelt), the way Codex and Claude Code sandbox them
 * there. They can read anything, but write only inside the project, its git directory and the temp
 * directories, and without `network` they can only connect to localhost. Unlike a container, this
 * keeps the user's own toolchain (python, node, compilers) working with no setup.
 * Returns undefined where jig has no sandbox yet (anything but macOS).
 */
export function createSandbox(root: string, { network, dirs = [] }: { network: boolean; dirs?: string[] }): Sandbox | undefined {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return undefined;
  const project = realpathSync(root); // Seatbelt sees real paths: /var is /private/var
  const added = dirs.map((dir) => realpathSync(dir));
  const writable = [project, gitDir(project), ...added, realpathSync(tmpdir()), "/private/tmp"].filter(
    (dir, i, all): dir is string => !!dir && !all.slice(0, i).some((other) => other && isInside(other, dir)),
  );
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
    limits: `Commands can write only inside the project${added.length ? `, ${added.join(", ")}` : ""} and the temp directories${network ? "" : ", and can't use the network except localhost"}.`,
    wrap: (command) => ({ program: SANDBOX_EXEC, args: ["-p", profile, "/bin/bash", "-c", command] }),
  };
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
