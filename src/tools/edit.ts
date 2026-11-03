// edit_file: replaces a string that must occur exactly once in the file. When it doesn't match, the error
// points at the nearest thing the file does hold (leftover line numbers, other indentation or spacing, a
// first line that matches), and when it matches more than once, it says where, so the model can fix its
// next try in one step. A file's Windows line endings are kept. With --tolerant-edits, an old_string the
// file doesn't hold is applied where it matches one place once typographic punctuation, or then trailing
// whitespace, doesn't count.

import { writeFile } from "node:fs/promises";
import type { Tool } from "./index.ts";
import { shownLine } from "./read.ts";
import { assertFile, lineCount, numbered, readUTF8, resolveForChange, toCRLF, usesCRLF } from "./util.ts";
import { checkChange } from "./write-check.ts";

export const editTool: Tool = {
  definition: {
    name: "edit_file",
    description:
      "Replace text in a file. old_string must match the file's current content exactly, including " +
      "whitespace and indentation, and must occur exactly once: include enough surrounding lines to make it " +
      "unique. Don't include the line-number prefixes from read_file. Read the file before editing it.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the working directory" },
        old_string: { type: "string", description: "The exact text to replace" },
        new_string: { type: "string", description: "The text to replace it with" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  kind: "edit",
  describe: ({ path, old_string, new_string }) =>
    [String(path), ...prefixLines(String(old_string), "- "), ...prefixLines(String(new_string), "+ ")].join("\n"),

  async run(input, ctx) {
    const { cwd, versions, dirs, hidden, gitLocked } = ctx;
    const { path, old_string: oldText, new_string: newText } = input as {
      path: string;
      old_string: string;
      new_string: string;
    };
    if (oldText === "") {
      throw new Error("old_string is empty. Use write_file to create a file, or include a nearby line in old_string.");
    }
    if (oldText === newText) throw new Error("old_string and new_string are identical; there is nothing to change.");
    const file = await resolveForChange(cwd, path, dirs, hidden, gitLocked);
    await assertFile(file, path);
    // No read-before-edit check here, unlike write_file: an exact, unique match of old_string already
    // shows the model knows the text it replaces, and can't overwrite anything it hasn't seen. In the
    // benchmark the check refused 22 edits across five runs, and every refusal was a false alarm.
    const text = await readUTF8(file, path);

    // The model writes \n line endings. In a file that uses \r\n, match in either style, and always write
    // new lines the file's way (a one-line old_string matches as-is, but its replacement can add lines).
    const crlf = usesCRLF(text);
    const search = crlf && !text.includes(oldText) ? toCRLF(oldText) : oldText;
    const replacement = crlf ? toCRLF(newText) : newText;

    const count = countOccurrences(text, search);
    const loose = count === 0 && ctx.tolerantEdits ? looseMatch(text, search) : undefined;
    if (count === 0 && !loose) throw new Error(explainMissing(path, text, oldText));
    if (count > 1) {
      throw new Error(
        `old_string occurs ${count} times in ${path} (starting at ${listLines(matchLines(text, search))}), ` +
          "but must occur exactly once. Include more surrounding lines to make it unique.",
      );
    }
    const at = loose?.at ?? text.indexOf(search);
    // With --check-writes, the file is checked as it is now, and again once written (see write-check.ts).
    const check = ctx.checkWrites ? await checkChange(file, path, text, ctx) : undefined;
    // Splice instead of text.replace(), which would expand patterns like $& and $1 in new_string.
    const edited = text.slice(0, at) + replacement + text.slice(loose?.end ?? at + search.length);
    await writeFile(file, edited);
    await versions.record(file);
    if (loose) ctx.count?.("edit.tolerant");
    const line = text.slice(0, at).split("\n").length;
    // A loose match is said to be one, so the model copies the file's own text next time.
    const how = loose ? ` (old_string matched only ${loose.ignoring})` : "";
    const done = `Edited ${path}: replaced ${lineCount(oldText)} at line ${line} with ${lineCount(newText)}${how}.`;
    return check ? done + (await check(edited)) : done;
  },
};

/** Counts overlapping matches too: "aa" occurs twice in "aaa", so it does not pick out one place. */
function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + 1)) count++;
  return count;
}

// Curly quotes, en and em dashes and no-break spaces, as the ASCII a model may type in their place.
const ASCII: Record<string, string> = { "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"', "\u2013": "-", "\u2014": "-", "\u00A0": " " };
const TYPOGRAPHIC = "taking curly quotes, dashes and no-break spaces as ASCII";

/** The text with that punctuation as ASCII. Each character stays one, so a match's offsets are the file's. */
function plain(text: string): string {
  return text.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u00A0]/g, (c) => ASCII[c]);
}

/** Each line of a text, without its trailing whitespace (a \r included). */
function trimmedLines(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd());
}

/**
 * --tolerant-edits: where an old_string the file doesn't hold matches one place once curly quotes, dashes
 * and no-break spaces count as ASCII, or failing that once trailing whitespace on each line doesn't count
 * either, and what was ignored to match it. Indentation always counts, and each step is taken only if it
 * finds exactly one place, so a looser match never chooses between places.
 */
function looseMatch(text: string, search: string): { at: number; end: number; ignoring: string } | undefined {
  // Whitespace alone would match wherever a line ends.
  if (!search.trim()) return undefined;
  const [file, old] = [plain(text), plain(search)];
  const count = countOccurrences(file, old);
  if (count > 1) return undefined;
  if (count === 1) {
    const at = file.indexOf(old);
    return { at, end: at + old.length, ignoring: TYPOGRAPHIC };
  }
  // Each line of old_string, then any trailing whitespace before the line break (a \r too). A last line of
  // whitespace alone is the next line's indentation, which counts. Trailing whitespace after text on the
  // last line stands for the end of a line, which it then must reach, short of the \r.
  const lines = old.split("\n");
  const indentation = lines.length > 1 && !lines.at(-1)!.trim() ? lines.pop()! : undefined;
  const escaped = lines.map((line) => line.trimEnd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const lineBreak = String.raw`[^\S\n]*\n`;
  const lineEnd = String.raw`[^\S\n]*?(?=\r?\n|$)`;
  const ending = indentation !== undefined ? lineBreak + indentation : /[^\S\n]$/.test(old) ? lineEnd : "";
  // A blank first line matches from the start of the whitespace before a line break (a \r too), so one
  // place isn't found again from each character of it.
  const start = escaped[0] === "" ? String.raw`(?<![^\S\n])` : "";
  const pattern = new RegExp(start + escaped.join(lineBreak) + ending, "g");
  const found: RegExpExecArray[] = [];
  for (let match = pattern.exec(file); match && found.length < 2; match = pattern.exec(file)) {
    found.push(match);
    pattern.lastIndex = match.index + 1; // overlapping matches count, as in countOccurrences
  }
  if (found.length !== 1) return undefined;
  const [{ index: at, 0: matched }] = found;
  const end = at + matched.length;
  const punctuation = trimmedLines(text.slice(at, end)).join("\n") !== trimmedLines(search).join("\n");
  return { at, end, ignoring: `ignoring trailing whitespace${punctuation ? ` and ${TYPOGRAPHIC}` : ""}` };
}

/** The lines that matches start on, each once, so the model can tell which context sets its own apart. */
function matchLines(text: string, search: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let newline = text.indexOf("\n");
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + 1)) {
    for (; newline !== -1 && newline < i; newline = text.indexOf("\n", newline + 1)) line++;
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines;
}

/** "line 3", or "lines 3, 8, 12": at most 10, since a short string can occur on hundreds of lines. */
function listLines(lines: number[]): string {
  if (lines.length === 1) return `line ${lines[0]}`;
  return `lines ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? ", ..." : ""}`;
}

/**
 * Why old_string did not match, pointing at the nearest thing in the file so the model can fix its next
 * attempt in one step: leftover line numbers, different indentation or spacing, or where its first line
 * appears.
 */
function explainMissing(path: string, text: string, oldText: string): string {
  const missing = `old_string was not found in ${path}.`;
  const oldLines = oldText.split("\n");
  if (oldLines.filter((line) => line.trim()).every((line) => /^\s*\d+\t/.test(line))) {
    return `${missing} Its lines start with line numbers, which read_file only adds for display. Leave them out.`;
  }
  const fileLines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const wanted = oldLines.map((line) => line.trim());
  while (wanted.length > 1 && wanted.at(-1) === "") wanted.pop();
  while (wanted.length > 1 && wanted[0] === "") wanted.shift();

  // Where old_string would match if whitespace didn't count: first as whole lines with other indentation.
  let starts = linesWhere(fileLines, wanted, (line, want) => line.trim() === want);
  const last = wanted.length - 1;
  const squeezed = wanted.map(squeeze);
  const loose = starts.length === 0 && wanted.some((line) => line !== "");
  if (loose) {
    // Failing that, with any spacing at all, and its first and last lines may be parts of lines (the end
    // of one, the start of the other, or any part of a single line), as when it began mid-line. Each line
    // is squeezed as it is compared: a squeezed copy of the whole file tripled the memory a miss took.
    starts = linesWhere(fileLines, squeezed, (fileLine, want, j) => {
      const line = squeeze(fileLine);
      if (last === 0) return line.includes(want);
      return j === 0 ? line.endsWith(want) : j === last ? line.startsWith(want) : line === want;
    });
  }
  if (starts.length === 1) {
    const [start] = starts;
    if (loose && (squeeze(fileLines[start]) !== squeezed[0] || squeeze(fileLines[start + last]) !== squeezed[last])) {
      // Only part of a line matches. Told to copy the whole line, a model that kept new_string to the
      // part would delete the rest of the line. So the error shows just the part, about as long as
      // old_string.
      const lines = last === 0 ? `line ${start + 1}` : `lines ${start + 1}-${start + wanted.length}`;
      return (
        `${missing} Part of ${lines} matches it except for whitespace. Copy that part exactly; new_string ` +
        `replaces just that part:\n${part(fileLines, start, squeezed, oldLines)}`
      );
    }
    // Shown whole, however long: they are to be copied, and old_string held them already, whitespace aside.
    const span = last === 0 ? `Line ${start + 1} matches` : `Lines ${start + 1}-${start + wanted.length} match`;
    return (
      `${missing} ${span} it except for whitespace (indentation or spacing). ` +
      `Copy ${last === 0 ? "it" : "them"} exactly:\n${numbered(fileLines.slice(start, start + wanted.length), start)}`
    );
  }
  if (starts.length > 1) {
    const where = listLines(starts.map((start) => start + 1));
    return `${missing} Ignoring whitespace it matches ${starts.length} places (starting at ${where}), so the whitespace differs and more context is needed.`;
  }
  const first = wanted.find((line) => line !== "");
  const at = first === undefined ? -1 : fileLines.findIndex((line) => line.trim() === first);
  if (first !== undefined && at !== -1) {
    return (
      `${missing} Its first line matches line ${at + 1}, but the lines after it differ. The file there reads:\n` +
      excerpt(fileLines, at, Math.min(wanted.length + 2, 15))
    );
  }
  return `${missing} It must match exactly, including whitespace and indentation. Read the file again to see its current content.`;
}

/** The file lines at which every wanted line, in turn, fits. */
function linesWhere(
  fileLines: string[],
  wanted: string[],
  fits: (line: string, want: string, j: number) => boolean,
): number[] {
  const starts: number[] = [];
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    if (wanted.every((want, j) => fits(fileLines[i + j], want, j))) starts.push(i);
  }
  return starts;
}

function squeeze(line: string): string {
  return line.replace(/\s+/g, "");
}

/** Where `line` holds the character at `n` in squeeze(line). */
function unsqueezed(line: string, n: number): number {
  let at = n;
  for (const space of line.matchAll(/\s+/g)) {
    if (space.index > at) break;
    at += space[0].length;
  }
  return at;
}

/**
 * The text in the file that old_string stands for, other spacing aside: its lines are `wanted`, squeezed,
 * and the first of them is in the file at line `start`. It runs from the first character that matches
 * to the last, and takes in the file's whitespace on either side where old_string has some there too,
 * as with indentation, which new_string probably repeats.
 */
function part(fileLines: string[], start: number, wanted: string[], oldLines: string[]): string {
  const last = wanted.length - 1;
  const [first, end] = [fileLines[start], fileLines[start + last]];
  const at = last === 0 ? squeeze(first).indexOf(wanted[0]) : squeeze(first).length - wanted[0].length;
  let from = unsqueezed(first, at);
  let to = unsqueezed(end, (last === 0 ? at : 0) + wanted[last].length - 1) + 1;
  if (/^\s/.test(oldLines.find((line) => line.trim()) ?? "")) from = first.slice(0, from).trimEnd().length;
  if (/\s$/.test(oldLines.findLast((line) => line.trim()) ?? "")) to = end.length - end.slice(to).trimStart().length;
  if (last === 0) return first.slice(from, to);
  return [first.slice(from), ...fileLines.slice(start + 1, start + last), end.slice(0, to)].join("\n");
}

/**
 * File lines shown around where old_string's first line matches, numbered and cut as read_file shows them:
 * minified code can hold megabytes on one line, which could otherwise fill the conversation.
 */
function excerpt(fileLines: string[], start: number, count: number): string {
  return numbered(fileLines.slice(start, start + count).map((line) => shownLine(line)), start);
}

function prefixLines(text: string, prefix: string): string[] {
  return text === "" ? [] : text.split("\n").map((line) => prefix + line);
}
