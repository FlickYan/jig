import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves a path from the model against the project root and refuses anything outside it and the
 * directories added with --add-dir. The check is lexical, so a symlink inside can still lead out; the
 * sandbox is what actually confines commands.
 */
export function resolveInRoot(root: string, path: string, dirs: string[] = []): string {
  const abs = resolve(root, path);
  if (!isInside(root, abs) && !dirs.some((dir) => isInside(dir, abs))) {
    const also = dirs.length ? ` and in ${dirs.join(", ")}` : "";
    throw new Error(`${path} is outside the working directory (${root}). File tools only work inside it${also}.`);
  }
  return abs;
}

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

/** Converts line endings to Windows style (\r\n). */
export function toCRLF(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** Whether most of a file's lines end in \r\n. */
export function usesCRLF(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf >= text.split("\n").length - 1 - crlf;
}

export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** "1 line", "3 lines" */
export function lineCount(text: string): string {
  const n = countLines(text);
  return `${n} line${n === 1 ? "" : "s"}`;
}

/** Lines of a file in read_file's format: line numbers, a tab, the text. */
export function numbered(lines: string[], first: number, count: number): string {
  return lines
    .slice(first, first + count)
    .map((line, i) => `${String(first + i + 1).padStart(6)}\t${line}`)
    .join("\n");
}
