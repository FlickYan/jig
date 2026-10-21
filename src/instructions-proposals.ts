import { existsSync, writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { type Approve, notApproved } from "./proposals.ts";
import { findSecret } from "./secrets.ts";
import type { Tool } from "./tools/index.ts";
import { isInside, readRegularFile, resolveForChange } from "./tools/util.ts";

// Context that every agent working on a project should have, a convention or a rule, belongs in its
// AGENTS.md rather than in jig's memory: it travels with the repository and other agents read it too.
// jig proposes an edit, shows it as a diff, and writes it only if the user agrees.

/** The file a proposal edits: the project's AGENTS.md, or its CLAUDE.md where that is the one it has. */
export function instructionsFile(project: string): string {
  const agents = join(project, "AGENTS.md");
  const claude = join(project, "CLAUDE.md");
  return !existsSync(agents) && existsSync(claude) ? claude : agents;
}

/** propose_instructions: an addition to AGENTS.md, or a replacement of one passage, shown as a diff first. */
export function proposeInstructionsTool(approve: Approve): Tool {
  return {
    definition: {
      name: "propose_instructions",
      description:
        "Propose an edit to the project's AGENTS.md, the instructions every agent working here follows, for a convention " +
        "or rule that should hold in every later session (how to run the tests, what not to touch). Give the text to add; " +
        "with old_string, it replaces that passage instead. The user approves the edit first.",
      input_schema: {
        type: "object",
        properties: {
          new_string: { type: "string", description: "The Markdown to add, or to put in place of old_string" },
          old_string: { type: "string", description: "An exact passage of the file to replace (it must occur once)" },
          reason: { type: "string", description: "What the user said or did that shows this is how things are done here" },
        },
        required: ["new_string"],
        additionalProperties: false,
      },
    },
    kind: "propose",
    describe: ({ new_string }) => String(new_string).split("\n")[0],
    async run(input, ctx) {
      const { new_string: added, old_string: old, reason } = input as { new_string: string; old_string?: string; reason?: string };
      if (!added.trim()) throw new Error("new_string is empty.");
      const secret = findSecret(added);
      if (secret) throw new Error(`The edit seems to hold ${secret}; AGENTS.md must not contain secrets.`);
      const path = instructionsFile(ctx.cwd);
      const file = relative(ctx.cwd, path);
      // jig writes it itself, outside the sandbox, so it goes by where it really leads, as write_file does:
      // a symlink (a command can make one) mustn't take the edit out of the project, or to a git directory's
      // config. Checked again once approved, since a command left running could make one meanwhile.
      const check = () => resolveForChange(ctx.cwd, file, ctx.dirs, ctx.hidden);
      await check();
      // Only a regular file: a named pipe a command made in its place would have jig wait on it forever.
      const current = existsSync(path) ? readRegularFile(path) : "";
      if (current === undefined) throw new Error(`${file} isn't a regular file (a named pipe, say), so it can't be edited.`);
      let next: string;
      let diff: string;
      if (old) {
        const count = current.split(old).length - 1;
        if (count !== 1) throw new Error(count ? `old_string occurs ${count} times in ${file}; give more of the passage.` : `old_string isn't in ${file}.`);
        next = current.replace(old, () => added);
        diff = [...lines(old, "- "), ...lines(added, "+ ")].join("\n");
      } else {
        next = current.trim() ? `${current.trimEnd()}\n\n${added.trim()}\n` : `${added.trim()}\n`;
        diff = lines(added, "+ ").join("\n");
      }
      const shown = await linkedName(ctx.cwd, path, file);
      if (!(await approve(`${existsSync(path) ? "Edit" : "Create"} ${shown}?`, `${reason ? `  Why: ${reason}\n` : ""}${diff}`))) return notApproved(`edit to ${file}`);
      await check();
      writeFileSync(path, next);
      return `Edited ${shown}. It applies from the next session (or after /reset).`;
    },
  };
}

/** The file's name, and if it is a symlink, the file the edit really changes, for the user to see. */
async function linkedName(project: string, path: string, file: string): Promise<string> {
  if (!(await lstat(path).catch(() => null))?.isSymbolicLink()) return file;
  const [root, real] = await Promise.all([realpath(project), realpath(path)]);
  return `${file} (a link to ${isInside(root, real) ? relative(root, real) : real})`;
}

function lines(text: string, prefix: string): string[] {
  return text.trim().split("\n").map((line) => `  ${prefix}${line}`);
}
