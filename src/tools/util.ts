import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves a path from the model against the project root and refuses anything outside it.
 * The check is lexical, so a symlink inside the root can still lead out. The bash tool is not confined
 * at all: real isolation needs a sandbox (milestone 4).
 */
export function resolveInRoot(root: string, path: string): string {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${path} is outside the working directory (${root}). File tools only work inside it.`);
  }
  return abs;
}

/** Fails with a message the model can act on if `abs` is missing or is a directory. */
export async function assertFile(abs: string, path: string): Promise<void> {
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`File not found: ${path}`);
  if (info.isDirectory()) throw new Error(`${path} is a directory. Use bash (e.g. ls) to see what is in it.`);
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
