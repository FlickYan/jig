import { constants } from "node:buffer";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resolves a path from the model against the project root and refuses anything outside it and the
 * directories added with --add-dir. The check is lexical, so a symlink inside can still lead out: reading
 * may follow one (commands can read anything too), and resolveForChange checks changes by real path.
 */
export function resolveInRoot(root: string, path: string, dirs: string[] = []): string {
  const abs = resolve(root, path);
  if (!isInside(root, abs) && !dirs.some((dir) => isInside(dir, abs))) {
    const also = dirs.length ? ` and in ${dirs.join(", ")}` : "";
    throw new Error(`${path} is outside the working directory (${root}). File tools only work inside it${also}.`);
  }
  return abs;
}

/**
 * resolveInRoot for a file write_file or edit_file will change, checked again by where it really leads.
 * These tools run in jig's own process, out of the sandbox's reach, so a symlink in the project (a cloned
 * repository can hold one, a command can make one) would otherwise take a change to any file the user
 * can write, without a question in edits mode. A git directory's config and hooks are refused too, and
 * the files that tell git where they are: git runs the programs they name, outside the sandbox. A command
 * left running in the background could still swap a link between this check and the write.
 */
export async function resolveForChange(root: string, path: string, dirs: string[] = [], hidden: string[] = []): Promise<string> {
  const abs = resolveInRoot(root, path, dirs);
  const real = await realTarget(abs);
  if (!real) throw new Error(`${path} leads through a broken symlink. Change the file it should point to instead.`);
  if (await isHidden(real, hidden)) throw hiddenError(path); // first, so the message doesn't say where it is
  const allowed = await Promise.all([root, ...dirs].map((dir) => realTarget(dir)));
  if (!allowed.some((dir) => dir && isInside(dir, real))) {
    const also = dirs.length ? ` and in ${dirs.join(", ")}` : "";
    throw new Error(`${path} leads through a symlink to ${real}, outside the working directory (${root}). File tools only change files inside it${also}.`);
  }
  if (isGitControl(real)) {
    throw new Error(`${path} is a git directory's config or a hook, or tells git where they are, which can make git run programs outside the sandbox. The file tools don't change these; if the change is needed, ask the user to make it.`);
  }
  return abs;
}

/** Refuses a path the settings hide (hiddenPaths), wherever its symlinks lead: the sandbox hides it from commands. */
export async function assertVisible(abs: string, path: string, hidden: string[] = []): Promise<void> {
  if (!hidden.length) return;
  const real = await realTarget(abs);
  if (real && (await isHidden(real, hidden))) throw hiddenError(path);
}

/** Where the hidden paths really are, to check many files against (see listFiles). */
export async function realHiddenPaths(hidden: string[]): Promise<string[]> {
  return (await Promise.all(hidden.map((path) => realTarget(path)))).filter((path) => path !== undefined);
}

async function isHidden(real: string, hidden: string[]): Promise<boolean> {
  return (await realHiddenPaths(hidden)).some((path) => isInside(path, real));
}

function hiddenError(path: string): Error {
  return new Error(`${path} is hidden by the user's settings. Don't try to get around it.`);
}

/**
 * Where a path really leads, every symlink resolved. A path that doesn't exist yet leads where it would be
 * created: its nearest existing ancestor's real path, plus the rest. Undefined for a broken link, since
 * writing through one creates whatever it points to, and that can't be resolved here.
 */
export async function realTarget(abs: string): Promise<string | undefined> {
  let existing = abs;
  while (!(await lstat(existing).catch(() => null)) && dirname(existing) !== existing) existing = dirname(existing);
  const real = await realpath(existing).catch(() => undefined);
  return real && join(real, relative(existing, abs));
}

/**
 * Whether a real path is a git directory's config or one of its hooks, or a file that tells git where to
 * find them: a .git file (a worktree's or a submodule's pointer to its git directory, or one planted where
 * there was none) and commondir. A submodule's (under .git/modules) and a worktree's (under .git/worktrees)
 * count too. Any of them can make git run a program (core.fsmonitor, a pre-commit hook) the next time the
 * user or jig runs git, and grep and glob run git outside the sandbox. A bare repository's are left alone:
 * setting up a server's hooks can be the task.
 */
export function isGitControl(real: string): boolean {
  const parts = real.toLowerCase().split(sep); // macOS's file systems usually ignore case
  const at = parts.indexOf(".git");
  if (at === -1) return false;
  const rest = parts.slice(at + 1);
  if (!rest.length) return true;
  if (rest[0] === "modules" || rest[0] === "worktrees") return rest.includes("hooks") || GIT_CONFIG.includes(rest.at(-1) ?? "");
  return rest[0] === "hooks" || (rest.length === 1 && GIT_CONFIG.includes(rest[0]));
}

/** The files in a git directory that hold its config or say where it is. */
const GIT_CONFIG = ["config", "config.worktree", "commondir"];

/**
 * Options for the git that jig runs itself in a project (listing files for grep and glob, finding the
 * repository), in its own process where the sandbox doesn't reach. A repository's config can name
 * programs for git to run, and a command the model ran may have set one: core.fsmonitor runs on every
 * ls-files. So that is off, and hooks with it; the commands jig runs start nothing else the config names.
 * Run it with withoutKeys() as well.
 */
export const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

// jig's own credentials. The commands the model runs never need them, and they shouldn't see them: in
// the Terminal-Bench runs the model printed the environment with `env` to look around, which put the key
// into the conversation and the logs, and a prompt injection could send it somewhere instead.
const PRIVATE_ENV = ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"];

/** jig's environment without its credentials, for commands and for the git it runs in a project. */
export function withoutKeys(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !PRIVATE_ENV.includes(name)));
}

/** Whether an absolute path is root itself or below it. */
export function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** Fails with a message the model can act on if `abs` is missing or is a directory. */
export async function assertFile(abs: string, path: string): Promise<Stats> {
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`File not found: ${path}`);
  if (info.isDirectory()) throw new Error(`${path} is a directory. Use glob or bash (e.g. ls) to see what is in it.`);
  return info;
}

/**
 * The version (modification time and size) of each file as the model last saw it. write_file uses it to
 * refuse overwriting a file the model hasn't read, or one that changed since it did: a formatter, a
 * command or the user may have edited it, and a blind overwrite would undo their change.
 */
export class FileVersions {
  private readonly seen = new Map<string, string>();

  /** Call after the model reads or writes a file. Pass the stats taken before reading it, if any. */
  async record(abs: string, info?: Stats): Promise<void> {
    this.seen.set(abs, versionOf(info ?? (await stat(abs))));
  }

  /** After the files changed under the model (an /undo), so it must read them again. */
  forget(): void {
    this.seen.clear();
  }

  async assertCurrent(abs: string, path: string): Promise<void> {
    const seen = this.seen.get(abs);
    if (!seen) throw new Error(`You haven't read ${path} yet. Read it with read_file before changing it.`);
    if (versionOf(await stat(abs)) !== seen) {
      throw new Error(
        `${path} has changed since you last read it (a command, a formatter or the user may have edited it). ` +
          "Read it again before changing it.",
      );
    }
  }
}

function versionOf(info: Stats): string {
  return `${info.mtimeMs}:${info.size}`;
}

/**
 * A file's text, for edit_file and write_file to change. Only UTF-8 is read: decoded as UTF-8, another
 * encoding's characters outside ASCII become U+FFFD, and writing the text back would put U+FFFD in their
 * place all through the file, also in lines the change never touched (an é in a Latin-1 file, say). So a
 * file in another encoding is refused, and the model is told to change it with a command. So is a file
 * with more bytes than V8's longest string, before it is read: it may not fit in one, and reading it
 * whole could take all of a container's memory.
 */
export async function readUTF8(abs: string, path: string): Promise<string> {
  const { size } = await stat(abs);
  if (size > constants.MAX_STRING_LENGTH) {
    throw new Error(
      `${path} is ${Math.round(size / 1e6)} MB, too big for the file tools to change. ` +
        "Change it with bash instead, e.g. with sed.",
    );
  }
  const bytes = await readFile(abs);
  if (isUTF16(bytes)) throw utf16Error(path);
  const text = decodeUTF8(bytes);
  if (text === undefined) {
    throw new Error(
      `${path} isn't UTF-8 (it may be Latin-1 or Windows-1252), and the file tools only write UTF-8: its other ` +
        "characters outside ASCII would change too. Change it with bash instead, e.g. with sed, or iconv to convert it.",
    );
  }
  return text;
}

/**
 * Bytes as UTF-8 text, or undefined if they aren't valid UTF-8. A byte order mark stays in the text, so
 * that writing it back keeps the mark. `partial` is for bytes cut off mid-text: a character they end
 * halfway through is left out rather than taken as invalid.
 */
export function decodeUTF8(bytes: Uint8Array, partial = false): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: partial });
  } catch (err) {
    // Other errors, such as text too long for a string, say nothing about the encoding.
    if ((err as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA") return undefined;
    throw err;
  }
}

/** Whether bytes start with UTF-16's byte order mark, little- or big-endian. */
export function isUTF16(bytes: Uint8Array): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

export function utf16Error(path: string): Error {
  return new Error(
    `${path} is UTF-16 text, and the file tools only handle UTF-8. Use bash instead: iconv -f UTF-16 -t UTF-8 ` +
      "shows it, and a script that reads and writes it as UTF-16 can change it.",
  );
}

/** Converts line endings to Windows style (\r\n). */
export function toCRLF(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** Whether most of a file's lines end in \r\n. */
export function usesCRLF(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf >= text.split("\n").length - 1 - crlf;
}

/** Lines in a text, where a trailing newline ends the last line rather than starting another. */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** "1 line", "3 lines" */
export function lineCount(text: string): string {
  const n = countLines(text);
  return `${n} line${n === 1 ? "" : "s"}`;
}

/** Lines of a file in read_file's format: line numbers, a tab, the text. The first is at index `first` in the file. */
export function numbered(lines: string[], first: number): string {
  return lines.map((line, i) => `${String(first + i + 1).padStart(6)}\t${line}`).join("\n");
}
