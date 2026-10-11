import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Approve, notApproved } from "./proposals.ts";
import { findSecret } from "./secrets.ts";
import type { Tool } from "./tools/index.ts";

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
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      let next: string;
      let diff: string;
      if (old) {
        const count = current.split(old).length - 1;
        if (count !== 1) throw new Error(count ? `old_string occurs ${count} times in ${relative(ctx.cwd, path)}; give more of the passage.` : `old_string isn't in ${relative(ctx.cwd, path)}.`);
        next = current.replace(old, () => added);
        diff = [...lines(old, "- "), ...lines(added, "+ ")].join("\n");
      } else {
        next = current.trim() ? `${current.trimEnd()}\n\n${added.trim()}\n` : `${added.trim()}\n`;
        diff = lines(added, "+ ").join("\n");
      }
      const file = relative(ctx.cwd, path);
      if (!(await approve(`${existsSync(path) ? "Edit" : "Create"} ${file}?`, `${reason ? `  Why: ${reason}\n` : ""}${diff}`))) return notApproved(`edit to ${file}`);
      writeFileSync(path, next);
      return `Edited ${file}. It applies from the next session (or after /reset).`;
    },
  };
}

function lines(text: string, prefix: string): string[] {
  return text.trim().split("\n").map((line) => `  ${prefix}${line}`);
}
