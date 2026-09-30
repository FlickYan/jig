import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "./index.ts";
import { lineCount, resolveInRoot } from "./util.ts";

export const writeTool: Tool = {
  definition: {
    name: "write_file",
    description:
      "Create a new file, or replace the entire content of an existing one. Parent directories are created " +
      "as needed. To change part of an existing file, use edit_file instead.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the working directory" },
        content: { type: "string", description: "The complete content to write" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  readOnly: false,
  describe: ({ path, content }) => `${path} (${lineCount(String(content))})`,

  async run(input, { cwd }) {
    const { path, content } = input as { path: string; content: string };
    const file = resolveInRoot(cwd, path);
    const existed = existsSync(file);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return `${existed ? "Overwrote" : "Created"} ${path} (${lineCount(content)}).`;
  },
};
