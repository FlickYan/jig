// --overview: what a task's message carries besides the task, built without a model call. A conversation's
// first message gets the project's files, shallowest first, with their sizes; every task gets the files its
// words name, as read_file shows them, recorded as read so that write_file can replace them at once. In the
// evolve2 runs with budget notes (milestone 30), the model read the named files at its first step and the
// test file, whose path it learned from a listing, at its second or third, so the first write came at step
// 3 or 4, with no step left after the first test result. Facts only, and only those the model's own glob and
// read_file would give it unasked (run.ts says when they wouldn't): the model can still look anywhere.

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { firstVisible, listFiles, walkedNote } from "./tools/files.ts";
import { shownLine } from "./tools/read.ts";
import { assertVisible, decodeUTF8, type FileVersions, isInside, isUTF16, numbered, readRegularBytes, realTargetSync, resolveInRoot } from "./tools/util.ts";

/**
 * How many files the list shows, and how many bytes of the named files are shown, each and in all, so one
 * large file can't fill the context. Counted as read_file shows them, line numbers included: those add about
 * 8 bytes a line, so 16 KB of short lines could be several times that. An object, so that tests can lower
 * them.
 */
export const overviewLimits = { files: 200, fileBytes: 16 * 1024, totalBytes: 32 * 1024 };

/** An overview's two parts: the list of the project's files, and the files a task names. */
export type Part = "list" | "files";

export interface OverviewOptions {
  cwd: string;
  dirs?: string[];
  hidden?: string[];
  /** What the model has read: each file shown is recorded, by its stats before it was read, as read_file does. */
  versions: FileVersions;
  /** Whether to list the project's files: in a conversation's first message only, as later ones have it. */
  list: boolean;
  /**
   * The parts to leave out, as the model's own tools wouldn't show them to it unasked: the list where glob
   * wouldn't, the named files where read_file wouldn't. Nothing is read for them.
   */
  withheld?: Part[];
  /**
   * Whether write_file can replace the files shown: whether it is among the model's tools and the mode and
   * the rules let it write. Only then does the note say that those shown count as read.
   */
  writable?: boolean;
  /** Stops the git that lists the files, and the overview with it (Ctrl+C, --time-limit). */
  signal?: AbortSignal;
}

/**
 * The text to put before a task in the user's `words`, how many named files it shows, and which of the
 * withheld parts had something to show (the text is empty if that was all); or undefined when there is
 * nothing to say, or the directory is the root or the home directory, which aren't a project.
 */
export async function overview(words: string, { cwd, dirs = [], hidden = [], versions, list, withheld = [], writable = false, signal }: OverviewOptions): Promise<{ text: string; shown: number; left: Part[] } | undefined> {
  const real = realTargetSync(cwd);
  if (!real || real === dirname(real) || real === realTargetSync(homedir())) return undefined;
  // Without the list, the files are listed only if a word could name one: listing a large tree takes a few
  // hundred milliseconds.
  const paths = mentions(words, cwd);
  if (!list && !paths.length) return undefined;
  const { files, capped, gitTimedOut } = await listFiles(cwd, ".", dirs, hidden, signal);
  signal?.throwIfAborted();
  const sections: string[] = [];
  const left: Part[] = [];
  if (list && withheld.includes("list")) {
    left.push("list");
  } else if (list) {
    // Shallowest first, then by name as listed, so a cut keeps the project's layout. The list leaves out what
    // the file tools hide, as glob does; the named files are checked one by one below.
    const byDepth = files.map((file) => ({ file, depth: file.split("/").length })).sort((a, b) => a.depth - b.depth).map(({ file }) => file);
    const { files: visible, total } = await firstVisible(cwd, byDepth, overviewLimits.files, hidden, dirs);
    const lines = await Promise.all(
      visible.map(async (file) => {
        const info = await stat(resolve(cwd, file)).catch(() => undefined);
        return info?.isFile() ? `${file} (${size(info.size)})` : file;
      }),
    );
    if (!visible.length) lines.push("(none)");
    if (total > visible.length) lines.push(`(${capped ? "at least " : ""}${total - visible.length} more not listed)`);
    const header = "(Note from jig: the project's files, shallowest first, with their sizes; what git ignores, and folders like node_modules that git doesn't track, aren't listed.)";
    sections.push(`${header}\n${lines.join("\n")}${walkedNote(gitTimedOut)}`);
  }
  let shown = 0;
  let bytes = 0;
  const texts: string[] = [];
  const named = namedFiles(paths, files);
  const withholding = withheld.includes("files");
  if (withholding && named.length) left.push("files");
  for (const file of withholding ? [] : named) {
    const abs = resolveInRoot(cwd, file, dirs);
    // Nothing the settings hide, nor jig's own directory, wherever a link leads: read_file refuses them, and
    // the list leaves them out.
    if (!(await assertVisible(abs, file, hidden, [cwd, ...dirs]).then(() => true, () => false))) continue;
    const found = await shownFile(abs, bytes);
    if ("why" in found) {
      texts.push(`${file} isn't shown: ${found.why}.`);
      continue;
    }
    await versions.record(abs, found.info);
    shown++;
    bytes += Buffer.byteLength(found.text);
    texts.push(`${file}:\n${found.text}`);
  }
  if (texts.length) {
    // The model can't replace them where write_file isn't among its tools, or plan mode or a deny rule refuses it.
    const read = writable ? " Those shown count as read, so write_file can replace them." : "";
    sections.push(`(Note from jig: the files the task below names, as read_file shows them.${read})\n${texts.join("\n\n")}`);
  }
  return sections.length || left.length ? { text: sections.join("\n\n"), shown, left } : undefined;
}

/**
 * The paths `words` may name: each word with a dot or a slash in it (a path, not an ordinary word), without
 * the quotes, brackets or punctuation around it, relative to the project; an absolute path elsewhere is left out.
 */
function mentions(words: string, cwd: string): string[] {
  const paths: string[] = [];
  for (const word of words.split(/\s+/)) {
    let path = word.replace(/^[("'`[<{]+|[)"'`\]>}.,:;!?]+$/g, "").replace(/^(\.\/)+/, "");
    if (!/[./]/.test(path)) continue;
    if (isAbsolute(path)) path = isInside(cwd, path) ? relative(cwd, path) : "";
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * The listed files the `paths` name, in the order they first name them: a path that is a listed file's, or
 * the name of only one listed file.
 */
function namedFiles(paths: string[], files: string[]): string[] {
  const listed = new Set(files);
  const byName = new Map<string, string[]>();
  for (const file of files) byName.set(basename(file), [...(byName.get(basename(file)) ?? []), file]);
  const named = new Set<string>();
  for (const path of paths) {
    const one = byName.get(path);
    if (listed.has(path)) named.add(path);
    else if (!path.includes("/") && one?.length === 1) named.add(one[0]);
  }
  return [...named];
}

/**
 * A named file's text as read_file shows it, and its stats from before it was read, as read_file takes them
 * (so a change made during the read shows up later); or why it isn't shown, with `bytes` of the files' text
 * shown already.
 */
async function shownFile(abs: string, bytes: number): Promise<{ text: string; info: Stats } | { why: string }> {
  const info = await stat(abs).catch(() => undefined);
  if (!info?.isFile()) return { why: "it isn't a regular file" };
  // A larger file isn't read: numbered, its text would be larger still (but for lines read_file cuts).
  if (info.size > overviewLimits.fileBytes) return { why: `at ${size(info.size)}, it is over ${size(overviewLimits.fileBytes)}` };
  const text = utf8Text(abs);
  if (text === undefined) return { why: "it isn't UTF-8 text" };
  const shown = numberedText(text);
  const length = Buffer.byteLength(shown);
  if (length > overviewLimits.fileBytes) return { why: `with its line numbers, it is ${size(length)}, over ${size(overviewLimits.fileBytes)}` };
  if (bytes + length > overviewLimits.totalBytes) return { why: `with it, the files shown would be over ${size(overviewLimits.totalBytes)}` };
  return { text: shown, info };
}

/**
 * A regular file's text, or undefined if it isn't UTF-8 text: UTF-16, binary (a NUL byte), or not valid
 * UTF-8. Or if it grew past the limit since it was looked at, as only that much of it is read.
 */
function utf8Text(abs: string): string | undefined {
  try {
    // Opened without waiting, and checked again once open: a named pipe put in its place isn't read.
    const file = readRegularBytes(abs, overviewLimits.fileBytes);
    if (!file || file.size > overviewLimits.fileBytes || isUTF16(file.bytes) || file.bytes.subarray(0, 8192).includes(0)) return undefined;
    return decodeUTF8(file.bytes);
  } catch {
    return undefined;
  }
}

/** A file's text in read_file's format: numbered lines without their \r, each cut as read_file cuts it. */
function numberedText(text: string): string {
  if (text === "") return "(empty file)";
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return numbered(lines.map((line) => shownLine(line.replace(/\r$/, ""))), 0);
}

/** "9 bytes", "2.1 KB", "16 KB", "3.4 MB". */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  return bytes < 1024 ** 2 ? `${Number((bytes / 1024).toFixed(1))} KB` : `${Number((bytes / 1024 ** 2).toFixed(1))} MB`;
}
