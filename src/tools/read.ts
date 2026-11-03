// read_file: a text file's lines with their numbers, like `cat -n`, a page at a time for long files. It
// records the version of the file the model saw (FileVersions), which write_file checks before overwriting.

import { open } from "node:fs/promises";
import type { Tool } from "./index.ts";
import { assertFile, assertVisible, decodeUTF8, isUTF16, resolveInRoot, utf16Error } from "./util.ts";

const DEFAULT_LIMIT = 2000; // lines per call
const MAX_LINE_CHARS = 2000; // minified files have enormous lines
const MAX_CHARS = 30_000; // per call; longer files are read in pages with offset
const LINE_BYTES = 4 * MAX_LINE_CHARS; // kept of a line: UTF-8 takes 4 bytes a character at most
const CHUNK_BYTES = 65_536; // read at a time
const COUNT_BYTES = 50_000_000; // once the page is full, lines are counted only this far into a file

export const readTool: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read a text file. Returns its lines prefixed with line numbers, like `cat -n`. " +
      "Read a file before editing it. " +
      `Returns up to ${DEFAULT_LIMIT} lines; for longer files, use offset and limit to read the part you need ` +
      "(grep finds the line numbers).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the working directory" },
        offset: { type: "integer", description: "Line number to start from (1-based, default 1)" },
        limit: { type: "integer", description: `Maximum number of lines to return (default ${DEFAULT_LIMIT})` },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  kind: "read",
  describe: ({ path, offset }) => (offset ? `${path}:${offset}` : String(path)),

  async run(input, { cwd, versions, dirs = [], hidden }) {
    const { path, offset = 1, limit = DEFAULT_LIMIT } = input as { path: string; offset?: number; limit?: number };
    const file = resolveInRoot(cwd, path, dirs);
    await assertVisible(file, path, hidden, [cwd, ...dirs]);
    const info = await assertFile(file, path); // taken before reading, so a change during the read shows up later
    const first = Math.max(offset, 1);
    const page = await readPage(file, path, first, Math.max(limit, 1));
    if (page.lines === 0) {
      await versions.record(file, info);
      return "(empty file)";
    }
    if (first > page.lines) throw new Error(`offset ${offset} is past the end of ${path} (${page.lines} lines).`);

    let out = page.text;
    if (page.last < page.lines || !page.counted) {
      const of = page.counted
        ? page.lines
        : `at least ${page.lines} (the file is ${Math.round(info.size / 1e6)} MB, too big to count to the end)`;
      out += `\n(Showed lines ${first}-${page.last} of ${of}. Use offset=${page.last + 1} to continue.)`;
    }
    if (page.invalid) {
      out +=
        `\n(${path} isn't all UTF-8: � stands for bytes that aren't, and it may be Latin-1 or Windows-1252. ` +
        "edit_file and write_file won't change it, as they would change those bytes too; use bash, e.g. sed.)";
    }
    await versions.record(file, info);
    return out;
  },
};

/**
 * A line as read_file shows it: cut to MAX_LINE_CHARS and marked, if it is longer or was `cut` already.
 * edit_file shows the lines around a near miss the same way.
 */
export function shownLine(text: string, cut = false): string {
  return cut || text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… [line truncated]` : text;
}

interface Page {
  /** The lines shown, numbered. */
  text: string;
  /** The number of the last line shown. */
  last: number;
  /** How many lines the file has, or how many were counted. */
  lines: number;
  /** Whether `lines` counts all of the file. */
  counted: boolean;
  /** Whether a line shown isn't valid UTF-8. */
  invalid: boolean;
}

/**
 * The page of a file that starts at line `first`, read a chunk at a time into one buffer. Reading the
 * whole file to show a page took 800 MB of memory for 5 lines of a 300 MB log, the kind of use that got
 * grep killed at a container's 2 GB limit (milestone 8), and past V8's longest string (about 512 MB) the
 * read failed outright. Only the lines shown are kept, each cut at what can be shown of it, and once the
 * page is full, lines are counted at most COUNT_BYTES into the file.
 */
async function readPage(file: string, path: string, first: number, limit: number): Promise<Page> {
  const page: Page = { text: "", last: first - 1, lines: 0, counted: true, invalid: false };
  let line = 1; // the line the next byte belongs to
  let full = false; // whether the page holds all it can
  let parts: Buffer[] = []; // what is kept of a line on the page
  let size = 0; // the line's bytes so far, kept or not

  const keep = (bytes: Buffer) => {
    if (size < LINE_BYTES) parts.push(Buffer.from(bytes.subarray(0, LINE_BYTES - size))); // a copy: the chunk is reused
    size += bytes.length;
  };
  // The line ended: show it, if it fits.
  const add = () => {
    const cut = size > LINE_BYTES;
    const bytes = Buffer.concat(parts);
    [parts, size] = [[], 0];
    const decoded = decodeUTF8(bytes, cut);
    let text = decoded ?? bytes.toString("utf8"); // with � for each byte that isn't UTF-8
    if (!cut) text = text.replace(/\r$/, ""); // edit_file handles Windows line endings itself
    text = shownLine(text, cut);
    const numbered = `${String(line).padStart(6)}\t${text}\n`;
    if (page.text.length + numbered.length > MAX_CHARS && line > first) {
      full = true;
      return;
    }
    page.text += numbered;
    page.last = line;
    page.invalid ||= decoded === undefined;
    full = line - first + 1 >= limit;
  };

  const chunk = Buffer.alloc(CHUNK_BYTES);
  let atLineStart = true; // the last byte read ended a line, or there was none
  const handle = await open(file);
  try {
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      // Checked once this read has found more of the file: when the page ends at its end, the count is exact.
      if (full && position >= COUNT_BYTES) {
        page.counted = false;
        break;
      }
      const bytes = chunk.subarray(0, bytesRead);
      if (position === 0) {
        if (isUTF16(bytes)) throw utf16Error(path); // which has NUL bytes, but isn't binary
        if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${path} looks like a binary file; not reading it.`);
      }
      position += bytesRead;
      for (let start = 0; start < bytes.length; ) {
        const end = bytes.indexOf(10, start); // a newline byte is never part of another character in UTF-8
        const onPage = !full && line >= first;
        if (end === -1) {
          if (onPage) keep(bytes.subarray(start));
          break;
        }
        if (onPage) {
          keep(bytes.subarray(start, end));
          add();
        }
        line++;
        start = end + 1;
      }
      atLineStart = bytes[bytesRead - 1] === 10;
    }
  } finally {
    await handle.close();
  }
  if (!atLineStart && !full && line >= first) add(); // the last line, with no newline after it
  page.lines = atLineStart ? line - 1 : line;
  return page;
}
