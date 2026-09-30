import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { globToRegExp, listFiles } from "./files.ts";
import type { Tool } from "./index.ts";

const MAX_MATCHES = 200; // lines shown
const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 5_000_000;

export const grepTool: Tool = {
  definition: {
    name: "grep",
    description:
      "Search the contents of files with a regular expression (JavaScript syntax). Returns matching lines as " +
      "path:line: text. Searches the whole project by default, skipping .git, node_modules and files git " +
      "ignores. Use it to find where something is defined or used before reading files; read_file can then " +
      "start at the line number it gives.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "File or directory to search, relative to the working directory (default: .)" },
        include: {
          type: "string",
          description: "Only search files matching this glob, e.g. *.py (any directory) or src/**/*.ts",
        },
        ignore_case: { type: "boolean", description: "Match regardless of case (default false)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  kind: "read",
  describe: ({ pattern, path, include }) =>
    [String(pattern), path && `in ${path}`, include && `(${include})`].filter(Boolean).join(" "),

  async run(input, { cwd }) {
    const { pattern, path = ".", include, ignore_case } = input as {
      pattern: string;
      path?: string;
      include?: string;
      ignore_case?: boolean;
    };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? "i" : "");
    } catch (err) {
      throw new Error(`Invalid regular expression: ${(err as Error).message}`);
    }
    const includeRegex = include ? globToRegExp(include) : null;

    const shown: string[] = [];
    let total = 0;
    for (const file of await listFiles(cwd, path)) {
      // Like ripgrep: a glob without "/" matches file names in any directory.
      if (includeRegex && !includeRegex.test(include!.includes("/") ? file : basename(file))) continue;
      const bytes = await readFile(join(cwd, file)).catch(() => null);
      if (!bytes || bytes.length > MAX_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) continue;
      bytes
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!regex.test(line)) return;
          total++;
          if (shown.length < MAX_MATCHES) shown.push(`${file}:${i + 1}: ${clip(line.replace(/\r$/, ""))}`);
        });
    }
    if (total === 0) return "No matches.";
    if (total > shown.length) {
      shown.push(`\n(Showed ${shown.length} of ${total} matches. Narrow the search with path or include.)`);
    }
    return shown.join("\n");
  },
};

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}
