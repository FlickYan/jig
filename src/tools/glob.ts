// glob: finds files by a path pattern (*, **, ?, {a,b}, [abc]), skipping .git, node_modules and what git
// ignores. Paths come back relative to the project, ready for read_file.

import { relative, resolve } from "node:path";
import { globToRegExp, listFiles } from "./files.ts";
import type { Tool } from "./index.ts";
import { resolveInRoot } from "./util.ts";

const MAX_RESULTS = 200;

export const globTool: Tool = {
  definition: {
    name: "glob",
    description:
      "Find files by path pattern, e.g. **/*.py, src/**/*.test.ts or *.{json,yaml} (top level only). Returns " +
      "matching paths relative to the working directory, skipping .git, node_modules and files git ignores. " +
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

  async run(input, { cwd, dirs }) {
    const { pattern, path = "." } = input as { pattern: string; path?: string };
    const base = resolveInRoot(cwd, path, dirs);
    const regex = globToRegExp(pattern);
    // The pattern is relative to `path`; results are relative to the project, ready for read_file.
    const matches = (await listFiles(cwd, path, dirs)).filter((file) => regex.test(relative(base, resolve(cwd, file))));
    if (matches.length === 0) return "No files found.";
    const shown = matches.slice(0, MAX_RESULTS);
    if (matches.length > shown.length) {
      shown.push(`\n(Showed ${shown.length} of ${matches.length} files. Use a narrower pattern or path.)`);
    }
    return shown.join("\n");
  },
};
