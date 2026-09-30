import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "./index.ts";
import { assertFile, lineCount, resolveInRoot } from "./util.ts";

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
  readOnly: false,
  describe: ({ path, old_string, new_string }) =>
    [String(path), ...prefixLines(String(old_string), "- "), ...prefixLines(String(new_string), "+ ")].join("\n"),

  async run(input, { cwd }) {
    const { path, old_string: oldText, new_string: newText } = input as {
      path: string;
      old_string: string;
      new_string: string;
    };
    if (oldText === "") {
      throw new Error("old_string is empty. Use write_file to create a file, or include a nearby line in old_string.");
    }
    if (oldText === newText) throw new Error("old_string and new_string are identical; there is nothing to change.");
    const file = resolveInRoot(cwd, path);
    await assertFile(file, path);
    const text = await readFile(file, "utf8");

    const count = countOccurrences(text, oldText);
    if (count === 0) {
      throw new Error(
        `old_string was not found in ${path}. It must match exactly, including whitespace and indentation. ` +
          "Read the file again to see its current content.",
      );
    }
    if (count > 1) {
      throw new Error(
        `old_string occurs ${count} times in ${path}, but must occur exactly once. ` +
          "Include more surrounding lines to make it unique.",
      );
    }
    const at = text.indexOf(oldText);
    // Splice instead of text.replace(), which would expand patterns like $& and $1 in new_string.
    await writeFile(file, text.slice(0, at) + newText + text.slice(at + oldText.length));
    const line = text.slice(0, at).split("\n").length;
    return `Edited ${path}: replaced ${lineCount(oldText)} at line ${line} with ${lineCount(newText)}.`;
  },
};

/** Counts overlapping matches too: "aa" occurs twice in "aaa", so it does not pick out one place. */
function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + 1)) count++;
  return count;
}

function prefixLines(text: string, prefix: string): string[] {
  return text === "" ? [] : text.split("\n").map((line) => prefix + line);
}
