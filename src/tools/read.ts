import { readFile } from "node:fs/promises";
import type { Tool } from "./index.ts";
import { assertFile, resolveInRoot } from "./util.ts";

const DEFAULT_LIMIT = 2000; // lines per call
const MAX_LINE_CHARS = 2000; // minified files have enormous lines
const MAX_CHARS = 30_000; // per call; longer files are read in pages with offset

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

  async run(input, { cwd, versions, dirs }) {
    const { path, offset = 1, limit = DEFAULT_LIMIT } = input as { path: string; offset?: number; limit?: number };
    const file = resolveInRoot(cwd, path, dirs);
    const info = await assertFile(file, path); // taken before reading, so a change during the read shows up later
    const bytes = await readFile(file);
    if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${path} looks like a binary file; not reading it.`);

    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop(); // a trailing newline does not start another line
    if (lines.length === 0) {
      await versions.record(file, info);
      return "(empty file)";
    }
    const first = Math.max(offset, 1);
    if (first > lines.length) throw new Error(`offset ${offset} is past the end of ${path} (${lines.length} lines).`);

    let out = "";
    let n = first;
    for (; n <= lines.length && n < first + Math.max(limit, 1); n++) {
      let line = lines[n - 1].replace(/\r$/, ""); // edit_file handles Windows line endings itself
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`;
      const numbered = `${String(n).padStart(6)}\t${line}\n`;
      if (out.length + numbered.length > MAX_CHARS && n > first) break;
      out += numbered;
    }
    const last = n - 1;
    if (last < lines.length) {
      out += `\n(Showed lines ${first}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`;
    }
    await versions.record(file, info);
    return out;
  },
};
