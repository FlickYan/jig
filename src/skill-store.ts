import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { jigHome } from "./paths.ts";
import { createSandbox, lockedGitPaths } from "./sandbox.ts";
import { frontmatterFields, listSkillFiles, nameProblems, skillProblems, userSkillsDir } from "./skills.ts";
import { assertVisible, isInside, readRegularBytes, readRegularFile, realTarget, realTargetSync, writeAnew } from "./tools/util.ts";

// Installing skills: from a folder, or from a folder in a git repository (GitHub shorthand, a GitHub page,
// or any git URL), into the user's skills or the project's. A lockfile beside them records where each came
// from, at which commit, so they can be updated or removed later.

/** Where skills come from: a folder on this machine, or a folder in a git repository. */
export interface SkillSource {
  /** As the user gave it, e.g. anthropics/skills/skills/pdf. */
  spec: string;
  /** The repository to clone; absent for a local folder. */
  url?: string;
  /** The folder inside the repository ("" for its root), or the local folder's absolute path. */
  path: string;
  /** A branch, tag or commit; absent for the repository's default branch. */
  ref?: string;
}

/**
 * Reads a source: a local folder (a path that exists, or starts with ./, ../, / or ~), a GitHub page URL
 * (https://github.com/owner/repo/tree/ref/path), a git URL, or GitHub shorthand: owner/repo[/path][@ref].
 */
export function parseSource(spec: string, { cwd = process.cwd(), ref, path }: { cwd?: string; ref?: string; path?: string } = {}): SkillSource {
  const expanded = spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : spec;
  if (/^(\.{1,2}\/|\/|~)/.test(spec) || existsSync(resolve(cwd, expanded))) return { spec, path: resolve(cwd, expanded) };
  const page = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+?))?\/?$/.exec(spec);
  if (page) return { spec, url: `https://github.com/${page[1]}/${page[2]}.git`, ref: ref ?? page[3], path: path ?? page[4] ?? "" };
  if (/^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(spec)) return { spec, url: spec, path: path ?? "", ...(ref && { ref }) };
  const short = /^([\w.-]+)\/([\w.-]+)((?:\/[^@]+)?)(?:@(.+))?$/.exec(spec);
  if (short) {
    const found = { spec, url: `https://github.com/${short[1]}/${short[2]}.git`, path: path ?? short[3].replace(/^\/|\/$/g, "") };
    return ref ?? short[4] ? { ...found, ref: ref ?? short[4] } : found;
  }
  throw new Error(`Can't tell where "${spec}" is: give a folder, a git URL, or owner/repo/path for GitHub.`);
}

/** A fetched source: the folder to look for skills in, the repository root and commit, and a cleanup. */
export interface Fetched {
  dir: string;
  root: string;
  commit?: string;
  cleanup(): void;
}

/**
 * The git URLs skills are fetched from: https, ssh (or scp-style, user@host:path) and file. A lockfile entry,
 * which a command can write, could name any other: git runs a program for some (ext::, or <helper>:: for any
 * git-remote-<helper> installed), and http:// and git:// don't check whom they reach.
 */
const FETCHED_URL = /^(https|ssh|file):\/\/|^\w[\w.-]*@[\w.-]+:/;

/**
 * Gets a source's files. A repository is cloned shallow and sparse into a temporary folder: only the
 * commit asked for, and only the files under the folder asked for, so one skill doesn't fetch a monorepo.
 * With `hidden` paths, git reads a file URL's repository in the sandbox, which hides them (see lockedSource).
 */
export function fetchSource(source: SkillSource, hidden: string[] = []): Fetched {
  if (!source.url) {
    if (!existsSync(source.path) || !statSync(source.path).isDirectory()) throw new Error(`${source.path} isn't a folder.`);
    return { dir: source.path, root: source.path, commit: gitCommit(source.path), cleanup() {} };
  }
  if (!FETCHED_URL.test(source.url)) throw new Error(`jig fetches skills only from https, ssh and file URLs, not ${source.url}.`);
  const tmp = mkdtempSync(join(tmpdir(), "jig-skills-"));
  const repo = join(tmp, "repo");
  const sandbox = hidden.length && source.url.startsWith("file://") ? createSandbox(tmp, { network: false, hidden }) : undefined;
  // The sandbox's keeper (on Linux) ends with jig anyway, but close it as soon as the fetch is done.
  const cleanup = () => {
    try {
      sandbox?.close?.();
    } catch {
      // nothing more to do
    }
    rmSync(tmp, { recursive: true, force: true });
  };
  // git refuses ext:: URLs, which run a command, unless a config allows them: this keeps them refused. In
  // the sandbox, git's arguments are bash's own ("$@", after $0), so the shell reads none of them. The sandbox
  // joins the session's namespaces through descriptors the spawn passes on (child fds 3 onwards, see Keeper).
  const git = (args: string[], cwd = tmp) => {
    const argv = ["-c", "protocol.ext.allow=never", ...args];
    const { program, args: wrapped, stdio } = sandbox ? sandbox.wrap('exec git "$@"') : { program: "git", args: [], stdio: undefined };
    return execFileSync(program, sandbox ? [...wrapped, "git", ...argv] : argv, { cwd, stdio: ["ignore", "pipe", "pipe", ...(stdio ?? [])], encoding: "utf8", timeout: 180_000 });
  };
  try {
    if (source.ref && /^[0-9a-f]{7,40}$/.test(source.ref)) {
      // A commit can't be cloned by name: fetch it into an empty repository instead.
      mkdirSync(repo);
      git(["init", "-q"], repo);
      git(["remote", "add", "origin", source.url], repo);
      git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", source.ref], repo);
      if (source.path) git(["sparse-checkout", "set", source.path], repo);
      git(["checkout", "-q", "FETCH_HEAD"], repo);
    } else {
      const sparse = source.path ? ["--sparse"] : [];
      git(["clone", "-q", "--depth", "1", "--filter=blob:none", ...sparse, ...(source.ref ? ["--branch", source.ref] : []), source.url, repo]);
      if (source.path) git(["sparse-checkout", "set", source.path], repo);
    }
  } catch (err) {
    cleanup();
    const { code, stderr } = err as { code?: string; stderr?: string };
    if (code === "ENOENT") throw new Error("Installing skills from a repository needs git, which isn't on the PATH.");
    const reason = String(stderr ?? (err as Error).message).trim().split("\n").filter((line) => !line.startsWith("warning:"))[0];
    throw new Error(`Couldn't fetch ${source.spec}: ${reason || "git failed"}`);
  }
  const dir = join(repo, source.path);
  if (!existsSync(dir)) {
    cleanup();
    throw new Error(`${source.url} has no folder ${source.path}${source.ref ? ` at ${source.ref}` : ""}.`);
  }
  return { dir, root: repo, commit: gitCommit(repo), cleanup };
}

function gitCommit(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** The skill folders in a fetched source: the folder itself if it has a SKILL.md, or the ones below it. */
export function findSkills(dir: string, depth = 3): string[] {
  if (existsSync(join(dir, "SKILL.md"))) return [dir];
  if (depth === 0) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => findSkills(join(dir, name), depth - 1));
}

/** What the user is shown before installing a skill. */
export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  files: string[];
  /** Files an agent might run: anything in scripts/, and programs by extension or executable bit. */
  scripts: string[];
  license?: string;
  /** What breaks the Agent Skills specification; a skill with problems isn't installed. */
  problems: string[];
}

/** What a skill holds, for the user to read before installing it: its files, which of them run, and its problems. */
export function describeSkill(dir: string): SkillInfo {
  const fields = frontmatterFields(readFileSync(join(dir, "SKILL.md"), "utf8"));
  const files = listSkillFiles(dir);
  // Eval files are inputs for test tasks, not programs the agent is told to run.
  const scripts = files.filter(
    (file) => !file.startsWith("evals/") && (file.startsWith("scripts/") || /\.(sh|bash|py|js|mjs|cjs|ts|rb|pl|ps1)$/.test(file) || (statSync(join(dir, file)).mode & 0o111) !== 0),
  );
  const licenseFile = files.find((file) => /^licen[sc]e/i.test(file));
  const license = fields.license || (licenseFile ? `see ${licenseFile}` : undefined);
  return { name: fields.name ?? basename(dir), description: fields.description ?? "", dir, files, scripts, ...(license && { license }), problems: skillProblems(dir) };
}

export type InstallScope = "user" | "project";

/** Where installed skills go, and where their lockfile is. */
export function skillsDir(scope: InstallScope, project: string): string {
  return scope === "user" ? userSkillsDir() : join(project, ".jig", "skills");
}

function lockPath(scope: InstallScope, project: string): string {
  return scope === "user" ? join(jigHome(), "skills-lock.json") : join(project, ".jig", "skills-lock.json");
}

/** Where an installed skill came from: enough to fetch it again. */
export interface LockEntry {
  source: string;
  url?: string;
  /** The skill's folder inside the repository, or on this machine. */
  path: string;
  ref?: string;
  commit?: string;
  installed: string;
}

/**
 * The lockfile's entries, by skill name; empty when there is no lockfile yet. The project's is within a
 * command's reach, and one that isn't a regular file is refused: jig would wait for good to read or write
 * a named pipe there (see readRegularFile).
 */
export function readLock(scope: InstallScope, project: string): Record<string, LockEntry> {
  const path = lockPath(scope, project);
  const text = readRegularFile(path);
  if (text === undefined) {
    if (existsSync(path)) throw new Error(`${path} isn't a regular file (a named pipe, say), so jig won't read or change it. A command may have put it there; if so, delete it.`);
    return {};
  }
  try {
    return JSON.parse(text).skills ?? {};
  } catch {
    return {};
  }
}

/**
 * Written anew and renamed into place (see writeAnew): the project's lockfile is within a command's reach,
 * and a named pipe a job left in the background put there after readLock would have jig wait for good.
 */
function writeLock(scope: InstallScope, project: string, skills: Record<string, LockEntry>): void {
  const path = lockPath(scope, project);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(skills).sort(([a], [b]) => a.localeCompare(b)));
  writeAnew(path, `${JSON.stringify({ version: 1, skills: sorted }, null, 2)}\n`);
}

/**
 * Refuses a path in the project that jig is about to replace or remove itself, outside the sandbox: a
 * skill's folder (installed, or one the model wrote), the lockfile, or AGENTS.md for an approved edit. A
 * project's .jig is within a command's reach, and a symlink a command put there (.jig, .jig/skills, a
 * skill's folder, the lockfile) would take the change out of the project. So the path goes by where it
 * really leads, as write_file's changes do, and stays out of any .git directory: write_file's check is for
 * one file, but a skill's folder is replaced whole, so with .jig/skills linked to .git/modules, a skill
 * named like a submodule would put its files in place of that submodule's config and hooks. Nor does it
 * go into what the sandbox locks in a git directory by another name (`locked`, see sandbox.ts's
 * lockedGitPaths; a session's, else worked out now), or hold any of it: with .jig/skills linked to the
 * project, a skill named like a git directory made with --separate-git-dir would replace it whole, config
 * included. The messages are jig's own, not write_file's, as the user reads them too. `dirs`, the --add-dir
 * directories, count as the project.
 */
export async function assertInProject(project: string, path: string, hidden: string[] = [], dirs: string[] = [], locked = lockedGitPaths(project, dirs)): Promise<void> {
  const shown = relative(project, path);
  const real = await realTarget(path);
  if (!real) throw new Error(`${shown} leads through a broken symlink, so jig won't change it. A command may have put it there; if so, delete it.`);
  await assertVisible(path, shown, hidden);
  const roots = await Promise.all([project, ...dirs].map((dir) => realTarget(dir)));
  if (!roots.some((root) => root && isInside(root, real))) throw new Error(`${shown} leads outside the project, to ${real}, so jig won't change it. A command may have put a link there.`);
  // Without case, as isGitControl: macOS's file systems usually ignore it.
  const lower = real.toLowerCase();
  const gitFiles = locked.map((file) => file.toLowerCase());
  if (lower.split(sep).includes(".git") || gitFiles.some((file) => isInside(file, lower))) {
    throw new Error(`${shown} leads into a git directory, to ${real}, so jig won't change it: what jig writes there could take the place of git's own files, such as a submodule's config. A command may have put a link there.`);
  }
  if (gitFiles.some((file) => isInside(lower, file))) {
    throw new Error(`${shown} leads to ${real}, which holds git's own files, such as a git directory's config, so jig won't change it. A command may have put a link there.`);
  }
}

/**
 * A skill's folder, checked before jig replaces or removes it, and in the project the lockfile with it
 * (see assertInProject). In either scope the name must be a skill's name, since the lockfile's names come
 * from a file commands can write: "../.." would be the project itself. And the lockfile, which jig then
 * rewrites, must be a regular file (see readLock).
 */
export async function skillDirForChange(scope: InstallScope, project: string, name: string): Promise<string> {
  const dir = join(skillsDir(scope, project), name);
  const lock = lockPath(scope, project);
  if (nameProblems(name).length) throw new Error(`"${name}" in ${lock} isn't a skill's name, so jig won't change ${dir}. A command may have put it there.`);
  if (scope === "project") for (const path of [dir, lock]) await assertInProject(project, path);
  readLock(scope, project);
  return dir;
}

/** Copies a fetched skill into place and records it in the lockfile. Returns where it went. */
export async function installSkill(info: SkillInfo, source: SkillSource, fetched: Fetched, { scope, project, force = false }: { scope: InstallScope; project: string; force?: boolean }): Promise<string> {
  if (info.problems.length) throw new Error(`The skill in ${info.dir} doesn't follow the Agent Skills format: ${info.problems.join(" ")}`);
  const target = await skillDirForChange(scope, project, info.name);
  if (existsSync(target) && !force) throw new Error(`There is already a skill "${info.name}" in ${target} (--force replaces it).`);
  rmSync(target, { recursive: true, force: true }); // a link in its place is removed, not what it leads to
  mkdirSync(dirname(target), { recursive: true });
  cpSync(info.dir, target, { recursive: true, filter: (path) => basename(path).toLowerCase() !== ".git" }); // as isGitControl
  const lock = readLock(scope, project);
  lock[info.name] = {
    source: source.spec,
    ...(source.url && { url: source.url }),
    path: source.url ? relative(fetched.root, info.dir) : info.dir,
    ...(source.ref && { ref: source.ref }),
    ...(fetched.commit && { commit: fetched.commit }),
    installed: new Date().toISOString(),
  };
  writeLock(scope, project, lock);
  return target;
}

/** An installed skill: its lockfile entry, and where it is. */
export interface Installed {
  name: string;
  scope: InstallScope;
  entry: LockEntry;
  dir: string;
}

/**
 * The skills installed with `jig skills add`, the project's and the user's; and the lockfiles left out, and
 * why (see readLock): a named pipe a command put in place of the project's mustn't keep the user's skills
 * from being listed or updated.
 */
export function installedSkills(project: string): { skills: Installed[]; problems: { scope: InstallScope; message: string }[] } {
  const skills: Installed[] = [];
  const problems: { scope: InstallScope; message: string }[] = [];
  for (const scope of ["project", "user"] as const) {
    try {
      for (const [name, entry] of Object.entries(readLock(scope, project))) skills.push({ name, scope, entry, dir: join(skillsDir(scope, project), name) });
    } catch (err) {
      problems.push({ scope, message: (err as Error).message });
    }
  }
  return { skills, problems };
}

/** Uninstalls a skill added with `jig skills add`: its folder and its lockfile entry. */
export async function removeSkill(skill: Installed, project: string): Promise<void> {
  rmSync(await skillDirForChange(skill.scope, project, skill.name), { recursive: true, force: true });
  const lock = readLock(skill.scope, project);
  delete lock[skill.name];
  writeLock(skill.scope, project, lock);
}

/**
 * The source of an installed skill, to fetch it again: the same repository folder at the same ref. The
 * project's lockfile is a file commands can write, so an entry may not be one jig wrote, and may name any
 * folder on this machine, or by a file URL any repository: one the settings hide is refused (see
 * assertShown). (fetchSource refuses the URLs jig doesn't fetch from. And git reads a file URL's
 * repository itself, where a .git file, the alternates or a link can lead it elsewhere: so fetchSource has
 * git do that in the sandbox, which hides those paths, if there is one.)
 */
export function lockedSource(entry: LockEntry, hidden: string[] = []): SkillSource {
  const fields = [entry?.source, entry?.path, entry?.url ?? "", entry?.ref ?? ""];
  if (!fields.every((field) => typeof field === "string")) throw new Error("its lockfile entry doesn't say where to fetch it from.");
  assertShown(entry, hidden);
  return entry.url ? { spec: entry.source, url: entry.url, path: entry.path, ...(entry.ref && { ref: entry.ref }) } : { spec: entry.source, path: entry.path };
}

/**
 * Refuses a source in the settings' hidden paths (`hidden`), or holding one, by where it really leads: a
 * folder, or a file URL's repository. Its files would land where commands can read them. `jig skills add`
 * refuses what update does, or it would install a skill that every later update refuses.
 */
export function assertShown(source: { url?: string; path: string }, hidden: string[]): void {
  const folders = !source.url ? [source.path] : source.url.startsWith("file://") ? fileUrlFolders(source.url) : [];
  const reals = hidden.map((path) => realTargetSync(path));
  for (const folder of folders) {
    // By the system's realpath, as the files are read: Node's own drops link/.. before it follows the link.
    let real: string;
    try {
      real = realpathSync.native(folder);
    } catch {
      continue; // nothing there to read
    }
    if (reals.some((path) => !!path && (isInside(path, real) || isInside(real, path)))) {
      throw new Error(`${source.url || source.path} is in a path the settings hide (hiddenPaths), or holds one, so jig won't copy it where commands can read it.`);
    }
  }
}

/**
 * The folders git may read a file URL's repository from: the path the URL names, and that path with .git
 * added, which git tries as well. git decodes the whole URL, then drops the host, up to the next /. One jig
 * can't take apart the same way is refused: a % it can't decode, a NUL, or a [, which starts a host that
 * can hold a / (in file://[a/b]/c, git reads /c).
 */
function fileUrlFolders(url: string): string[] {
  let rest: string | undefined;
  try {
    rest = decodeURIComponent(url.slice("file://".length));
  } catch {
    // git reads it some other way: it keeps a % without two hex digits after it, and decodes to any bytes
  }
  const slash = rest?.indexOf("/") ?? -1;
  if (rest === undefined || /[[\0]/.test(rest) || slash < 0) throw new Error(`jig can't tell which folder git would read for ${url}, so it won't fetch it.`);
  const repo = rest.slice(slash).replace(/(.)\/+$/, "$1"); // git drops a trailing / before it adds .git
  return [repo, `${repo}.git`];
}

/**
 * How two versions of a skill differ, file by file. A file in either that isn't a regular file is refused,
 * not read: a command can put a named pipe in a skill's folder (see readRegularFile).
 */
export function compareSkills(installed: string, fetched: string): { added: string[]; removed: string[]; changed: string[] } {
  const hash = (path: string) => {
    const file = readRegularBytes(path);
    if (!file) throw new Error(`${path} isn't a regular file (a named pipe, say), so jig won't read it. A command may have put it there; if so, delete it.`);
    return createHash("sha256").update(file.bytes).digest("hex");
  };
  const hashes = (dir: string) => new Map(listSkillFiles(dir).map((file) => [file, hash(join(dir, file))]));
  const before = hashes(installed);
  const after = hashes(fetched);
  return {
    added: [...after.keys()].filter((file) => !before.has(file)),
    removed: [...before.keys()].filter((file) => !after.has(file)),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)),
  };
}
