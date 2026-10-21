import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { jigHome } from "./paths.ts";
import { frontmatterFields, listSkillFiles, nameProblems, skillProblems, userSkillsDir } from "./skills.ts";
import { assertVisible, isInside, realTarget } from "./tools/util.ts";

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
 * Gets a source's files. A repository is cloned shallow and sparse into a temporary folder: only the
 * commit asked for, and only the files under the folder asked for, so one skill doesn't fetch a monorepo.
 */
export function fetchSource(source: SkillSource): Fetched {
  if (!source.url) {
    if (!existsSync(source.path) || !statSync(source.path).isDirectory()) throw new Error(`${source.path} isn't a folder.`);
    return { dir: source.path, root: source.path, commit: gitCommit(source.path), cleanup() {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "jig-skills-"));
  const repo = join(tmp, "repo");
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  const git = (args: string[], cwd = tmp) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 180_000 });
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

/** The lockfile's entries, by skill name; empty when there is no lockfile yet. */
export function readLock(scope: InstallScope, project: string): Record<string, LockEntry> {
  try {
    return JSON.parse(readFileSync(lockPath(scope, project), "utf8")).skills ?? {};
  } catch {
    return {};
  }
}

function writeLock(scope: InstallScope, project: string, skills: Record<string, LockEntry>): void {
  const path = lockPath(scope, project);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(skills).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ version: 1, skills: sorted }, null, 2)}\n`);
}

/**
 * Refuses a path in the project that jig is about to replace or remove itself, outside the sandbox: a
 * skill's folder (installed, or one the model wrote) or the lockfile. A project's .jig is within a
 * command's reach, and a symlink a command put there (.jig, .jig/skills, a skill's folder, the lockfile)
 * would take the change out of the project. So the path goes by where it really leads, as write_file's
 * changes do, and stays out of any .git directory: write_file's check is for one file, but a skill's
 * folder is replaced whole, so with .jig/skills linked to .git/modules, a skill named like a submodule
 * would put its files in place of that submodule's config and hooks. The messages are jig's own, not
 * write_file's, as the user reads them too.
 */
export async function assertInProject(project: string, path: string, hidden: string[] = []): Promise<void> {
  const shown = relative(project, path);
  const real = await realTarget(path);
  if (!real) throw new Error(`${shown} leads through a broken symlink, so jig won't change it. A command may have put it there; if so, delete it.`);
  await assertVisible(path, shown, hidden);
  const root = await realTarget(project);
  if (!root || !isInside(root, real)) throw new Error(`${shown} leads outside the project, to ${real}, so jig won't change it. A command may have put a link there.`);
  // Without case, as isGitControl: macOS's file systems usually ignore it.
  if (real.toLowerCase().split(sep).includes(".git")) {
    throw new Error(`${shown} leads into a git directory, to ${real}, so jig won't change it: a skill's files there could take the place of git's own, such as a submodule's config. A command may have put a link there.`);
  }
}

/**
 * A skill's folder, checked before jig replaces or removes it, and in the project the lockfile with it
 * (see assertInProject). In either scope the name must be a skill's name, since the lockfile's names come
 * from a file commands can write: "../.." would be the project itself.
 */
export async function skillDirForChange(scope: InstallScope, project: string, name: string): Promise<string> {
  const dir = join(skillsDir(scope, project), name);
  const lock = lockPath(scope, project);
  if (nameProblems(name).length) throw new Error(`"${name}" in ${lock} isn't a skill's name, so jig won't change ${dir}. A command may have put it there.`);
  if (scope === "project") for (const path of [dir, lock]) await assertInProject(project, path);
  return dir;
}

/** Copies a fetched skill into place and records it in the lockfile. Returns where it went. */
export async function installSkill(info: SkillInfo, source: SkillSource, fetched: Fetched, { scope, project, force = false }: { scope: InstallScope; project: string; force?: boolean }): Promise<string> {
  if (info.problems.length) throw new Error(`The skill in ${info.dir} doesn't follow the Agent Skills format: ${info.problems.join(" ")}`);
  const target = await skillDirForChange(scope, project, info.name);
  if (existsSync(target) && !force) throw new Error(`There is already a skill "${info.name}" in ${target} (--force replaces it).`);
  rmSync(target, { recursive: true, force: true }); // a link in its place is removed, not what it leads to
  mkdirSync(dirname(target), { recursive: true });
  cpSync(info.dir, target, { recursive: true, filter: (path) => basename(path) !== ".git" });
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

/** The skills installed with `jig skills add`, the project's and the user's. */
export function installedSkills(project: string): Installed[] {
  return (["project", "user"] as const).flatMap((scope) =>
    Object.entries(readLock(scope, project)).map(([name, entry]) => ({ name, scope, entry, dir: join(skillsDir(scope, project), name) })),
  );
}

/** Uninstalls a skill added with `jig skills add`: its folder and its lockfile entry. */
export async function removeSkill(skill: Installed, project: string): Promise<void> {
  rmSync(await skillDirForChange(skill.scope, project, skill.name), { recursive: true, force: true });
  const lock = readLock(skill.scope, project);
  delete lock[skill.name];
  writeLock(skill.scope, project, lock);
}

/** The source of an installed skill, to fetch it again: the same repository folder at the same ref. */
export function lockedSource(entry: LockEntry): SkillSource {
  // The project's lockfile is a file commands can write, so an entry may not be one jig wrote.
  const fields = [entry?.source, entry?.path, entry?.url ?? "", entry?.ref ?? ""];
  if (!fields.every((field) => typeof field === "string")) throw new Error("its lockfile entry doesn't say where to fetch it from.");
  return entry.url ? { spec: entry.source, url: entry.url, path: entry.path, ...(entry.ref && { ref: entry.ref }) } : { spec: entry.source, path: entry.path };
}

/** How two versions of a skill differ, file by file. */
export function compareSkills(installed: string, fetched: string): { added: string[]; removed: string[]; changed: string[] } {
  const hashes = (dir: string) => new Map(listSkillFiles(dir).map((file) => [file, createHash("sha256").update(readFileSync(join(dir, file))).digest("hex")]));
  const before = hashes(installed);
  const after = hashes(fetched);
  return {
    added: [...after.keys()].filter((file) => !before.has(file)),
    removed: [...before.keys()].filter((file) => !after.has(file)),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)),
  };
}
