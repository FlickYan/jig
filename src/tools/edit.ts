import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "./index.ts";
import { assertFile, lineCount, numbered, resolveInRoot, toCRLF, usesCRLF } from "./util.ts";

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

  async run(input, { cwd, versions, dirs }) {
    const { path, old_string: oldText, new_string: newText } = input as {
      path: string;
      old_string: string;
      new_string: string;
    };
    if (oldText === "") {
      throw new Error("old_string is empty. Use write_file to create a file, or include a nearby line in old_string.");
    }
    if (oldText === newText) throw new Error("old_string and new_string are identical; there is nothing to change.");
    const file = resolveInRoot(cwd, path, dirs);
    await assertFile(file, path);
    // No read-before-edit check here, unlike write_file: an exact, unique match of old_string already
    // shows the model knows the text it replaces, and can't overwrite anything it hasn't seen. In the
    // benchmark the check refused 22 edits across five runs, and every refusal was a false alarm.
    const text = await readFile(file, "utf8");

    // The model writes \n line endings. In a file that uses \r\n, match in either style, and always write
    // new lines the file's way (a one-line old_string matches as-is, but its replacement can add lines).
    const crlf = usesCRLF(text);
    const search = crlf && !text.includes(oldText) ? toCRLF(oldText) : oldText;
    const replacement = crlf ? toCRLF(newText) : newText;

    const count = countOccurrences(text, search);
    if (count === 0) throw new Error(explainMissing(path, text, oldText));
    if (count > 1) {
      throw new Error(
        `old_string occurs ${count} times in ${path}, but must occur exactly once. ` +
          "Include more surrounding lines to make it unique.",
      );
    }
    const at = text.indexOf(search);
    // Splice instead of text.replace(), which would expand patterns like $& and $1 in new_string.
    await writeFile(file, text.slice(0, at) + replacement + text.slice(at + search.length));
    await versions.record(file);
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

/**
 * Why old_string did not match, pointing at the nearest thing in the file so the model can fix its next
 * attempt in one step: leftover line numbers, different indentation, or where its first line appears.
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

  const starts: number[] = []; // where old_string would match if whitespace didn't count
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    if (wanted.every((line, j) => fileLines[i + j].trim() === line)) starts.push(i);
  }
  if (starts.length === 1) {
    return (
      `${missing} Lines ${starts[0] + 1}-${starts[0] + wanted.length} match it except for whitespace ` +
      `(indentation or spacing). Copy them exactly:\n${numbered(fileLines, starts[0], wanted.length)}`
    );
  }
  if (starts.length > 1) {
    const where = starts.map((start) => start + 1).join(", ");
    return `${missing} Ignoring whitespace it matches ${starts.length} places (starting at lines ${where}), so the indentation differs and more context is needed.`;
  }
  const first = wanted.find((line) => line !== "");
  const at = first === undefined ? -1 : fileLines.findIndex((line) => line.trim() === first);
  if (at !== -1) {
    return (
      `${missing} Its first line matches line ${at + 1}, but the lines after it differ. The file there reads:\n` +
      numbered(fileLines, at, Math.min(wanted.length + 2, 15))
    );
  }
  return `${missing} It must match exactly, including whitespace and indentation. Read the file again to see its current content.`;
}

function prefixLines(text: string, prefix: string): string[] {
  return text === "" ? [] : text.split("\n").map((line) => prefix + line);
}
