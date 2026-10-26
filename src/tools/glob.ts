// glob: finds files by a path pattern (*, **, ?, {a,b}, [abc]), skipping .git, node_modules and what git
// ignores. Paths come back relative to the project, ready for read_file.

import { relative, resolve } from "node:path";
import { firstVisible, globToRegExp, listFiles, relativeGlob, walkedNote } from "./files.ts";
import type { Tool } from "./index.ts";
import { resolveInRoot } from "./util.ts";

const MAX_RESULTS = 200;

export const globTool: Tool = {
  definition: {
    name: "glob",
    description:
      "Find files by path pattern, e.g. **/*.py, src/**/*.test.ts or *.{json,yaml} (top level only). Returns " +
      "matching paths relative to the working directory, skipping .git, node_modules and files git ignores, " +
      "unless path points into them (node_modules/pkg). " +
      "Use it to see how a project is laid out or to find files by name.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern; ** matches any number of directories" },
        path: { type: "string", description: "Directory to search in, relative to the working directory (default: .)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  kind: "read",
  describe: ({ pattern, path }) => (path ? `${pattern} in ${path}` : String(pattern)),

  async run(input, { cwd, dirs, hidden, signal }) {
    const { pattern, path = "." } = input as { pattern: string; path?: string };
    const base = resolveInRoot(cwd, path, dirs);
    const regex = globToRegExp(relativeGlob(pattern, base));
    // The pattern is relative to `path`; results are relative to the project, ready for read_file.
    const { files, capped, gitTimedOut } = await listFiles(cwd, path, dirs, hidden, signal);
    const matches = files.filter((file) => regex.test(relative(base, resolve(cwd, file))));
    const { files: shown, total } = await firstVisible(cwd, matches, MAX_RESULTS, hidden);
    // Outside git the listing stops at a limit, and what wasn't found there may still exist.
    const unlisted = capped && `the first ${files.length} files: the listing stops there`;
    const walked = walkedNote(gitTimedOut);
    if (shown.length === 0) return (unlisted ? `No files found in ${unlisted}. Narrow the search with path.` : "No files found.") + walked;
    const notes = [total > shown.length && `Showed ${shown.length} of ${total} files.`, unlisted && `Looked only at ${unlisted}.`];
    if (notes.some(Boolean)) {
      shown.push(`\n(${notes.filter(Boolean).join(" ")} ${unlisted ? "Narrow the search with path." : "Use a narrower pattern or path."})`);
    }
    return shown.join("\n") + walked;
  },
};
