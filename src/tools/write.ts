import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "./index.ts";
import { lineCount, resolveInRoot, toCRLF, usesCRLF } from "./util.ts";

export const writeTool: Tool = {
  definition: {
    name: "write_file",
    description:
      "Create a new file, or replace the entire content of an existing one (read it first). Parent directories " +
      "are created as needed. To change part of an existing file, use edit_file instead.",
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
  kind: "edit",
  describe: ({ path, content }) => `${path} (${lineCount(String(content))})`,

  async run(input, { cwd, versions }) {
    const { path, content } = input as { path: string; content: string };
    const file = resolveInRoot(cwd, path);
    const existing = await stat(file).catch(() => null);
    if (existing?.isDirectory()) throw new Error(`${path} is a directory.`);

    let text = content;
    let note = "";
    if (existing) {
      await versions.assertCurrent(file, path);
      // Keep a file's Windows line endings when the new content doesn't choose any itself.
      if (!content.includes("\r\n") && usesCRLF(await readFile(file, "utf8"))) {
        text = toCRLF(content);
        note = ", kept its CRLF line endings";
      }
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    await versions.record(file);
    return `${existing ? "Overwrote" : "Created"} ${path} (${lineCount(content)}${note}).`;
  },
};
