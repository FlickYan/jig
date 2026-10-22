import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { findSecret } from "./secrets.ts";
import type { SkillEval } from "./skill-evals.ts";
import { assertInProject } from "./skill-store.ts";
import { descriptionProblems, nameProblems, userSkillsDir } from "./skills.ts";
import { whyStopped } from "./tools/bash.ts";
import type { Tool, ToolInput } from "./tools/index.ts";
import * as ui from "./ui.ts";

// A skill the model wrote is a proposal: jig checks it against the Agent Skills specification, shows it to
// the user, and saves it only where they say. With no one to ask, it goes to .jig/proposals/skills/, a
// skill folder that `jig skills add` can install once someone has read it.

export interface SkillProposal {
  name: string;
  description: string;
  instructions: string;
  files?: Record<string, string>;
  evals?: Omit<SkillEval, "id">[];
}

/** Where a proposed skill goes: the project's skills, the user's, the proposals folder, or nowhere. */
export type Decision = "project" | "user" | "proposal" | null;

/**
 * Puts a proposal to the user. The default asks in the terminal; tests answer for them. The task's signal
 * stopping (at --time-limit) closes the question unanswered.
 */
export type Approver = (proposal: SkillProposal, files: Map<string, string>, signal?: AbortSignal) => Promise<Decision>;

const MAX_BYTES = 1_000_000;

/** propose_skill: a skill the model wrote, checked, then put to the user, who decides where it goes. */
export function proposeSkillTool(approve: Approver = askInTerminal): Tool {
  return {
    definition: {
      name: "propose_skill",
      description:
        "Propose a new skill, or a new version of one, for the user to approve: jig shows it to them and saves it only if " +
        "they agree. Use it when the user asks for a skill, or when /skills new or /learn asks you to, following the " +
        "skill-writer skill. Don't write a skill's files yourself.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "1-64 lowercase letters, digits and single hyphens; also the folder's name" },
          description: { type: "string", description: "What the skill does and when to use it, at most 1024 characters" },
          instructions: { type: "string", description: "The body of SKILL.md: the instructions, in Markdown" },
          files: { type: "object", description: "Other files of the skill: relative path -> content (scripts/, references/, evals/files/)" },
          evals: {
            type: "array",
            description: "Test tasks: objects with prompt, expected_output, expectations (statements to check), and optionally check (a shell command) and files",
          },
        },
        required: ["name", "description", "instructions"],
        additionalProperties: false,
      },
    },
    kind: "propose", // it changes nothing itself: the user decides
    describe: ({ name }) => String(name),

    async run(input, ctx) {
      const proposal = toProposal(input);
      const files = skillFiles(proposal);
      const decision = await approve(proposal, files, ctx.signal);
      if (!decision && ctx.signal?.aborted) return `Nothing was saved: ${whyStopped(ctx.signal, "the user stopped the task")}.`;
      if (!decision) return "The user didn't keep this skill. If it isn't clear why, ask them what to change.";
      const target =
        decision === "user" ? join(userSkillsDir(), proposal.name)
        : decision === "project" ? join(ctx.cwd, ".jig", "skills", proposal.name)
        : join(ctx.cwd, ".jig", "proposals", "skills", proposal.name);
      // jig writes it itself, outside the sandbox, so in the project it is checked as jig skills add checks
      // a skill's folder: a symlink a command made (.jig, say) mustn't take the files, or the removal of an
      // earlier version, out of the project, or into a submodule's git directory in place of its config.
      if (decision !== "user") await assertInProject(ctx.cwd, target, ctx.hidden);
      writeSkill(target, files);
      if (decision === "proposal") {
        return `Nobody could approve the skill now, so it was saved as a proposal in ${target}. The user can read it and install it with: jig skills add ${target}`;
      }
      return `Saved the skill "${proposal.name}" in ${target}. It is available from the next session (or after /reset).`;
    },
  };
}

/** Checks the input against the specification; what is wrong goes back to the model to fix. */
function toProposal(input: ToolInput): SkillProposal {
  const { name, description, instructions, files = {}, evals = [] } = input as unknown as SkillProposal;
  const problems = [...nameProblems(String(name)), ...descriptionProblems(String(description))];
  if (!String(instructions).trim()) problems.push("The instructions are empty.");
  if (typeof files !== "object" || Array.isArray(files)) problems.push("files must map relative paths to contents.");
  for (const [path, content] of Object.entries(files ?? {})) {
    const clean = normalize(path);
    if (isAbsolute(path) || clean.startsWith("..") || clean.split(sep).includes("..")) problems.push(`The file ${path} isn't inside the skill's folder.`);
    else if (clean === "SKILL.md" || clean === join("evals", "evals.json")) problems.push(`${path} is written from the other fields; leave it out of files.`);
    if (typeof content !== "string") problems.push(`The content of ${path} isn't text.`);
  }
  if (!Array.isArray(evals) || evals.some((item) => typeof item?.prompt !== "string")) problems.push("Each eval needs a prompt.");
  const secret = findSecret([description, instructions, ...Object.values(files ?? {}).map(String)].join("\n"));
  if (secret) problems.push(`It seems to hold ${secret}; a skill must not contain secrets (point to where one is kept instead).`);
  if (problems.length) throw new Error(`The skill can't be proposed as it is: ${problems.join(" ")}`);
  return { name, description, instructions, files, evals };
}

/** The skill's files: SKILL.md from the fields, the other files, and evals/evals.json. */
export function skillFiles(proposal: SkillProposal): Map<string, string> {
  const files = new Map<string, string>();
  // Double quotes and JSON escapes are valid YAML, and safe whatever the description holds.
  files.set("SKILL.md", `---\nname: ${proposal.name}\ndescription: ${JSON.stringify(proposal.description.replace(/\s+/g, " ").trim())}\n---\n\n${proposal.instructions.trim()}\n`);
  for (const [path, content] of Object.entries(proposal.files ?? {})) files.set(normalize(path), content);
  if (proposal.evals?.length) {
    const evals = proposal.evals.map((item, index) => ({ id: index + 1, ...item }));
    files.set(join("evals", "evals.json"), `${JSON.stringify({ skill_name: proposal.name, evals }, null, 2)}\n`);
  }
  const bytes = [...files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  if (bytes > MAX_BYTES) throw new Error(`The skill is ${Math.round(bytes / 1000)} kB; keep it under ${MAX_BYTES / 1000} kB (put large data elsewhere).`);
  return files;
}

/** Writes a skill, replacing any earlier version in the same place, so no stale file is left behind. */
function writeSkill(dir: string, files: Map<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, { mode: path.startsWith(`scripts${sep}`) ? 0o755 : 0o644 });
  }
}

/** The default approver: shows the skill and asks where to keep it. With no terminal, it becomes a proposal. */
export async function askInTerminal(proposal: SkillProposal, files: Map<string, string>, signal?: AbortSignal): Promise<Decision> {
  if (!process.stdin.isTTY) return "proposal";
  ui.println();
  ui.println(`${ui.bold(`Proposed skill: ${proposal.name}`)}`);
  ui.println(`  ${proposal.description}`);
  for (const [path, content] of files) ui.println(ui.dim(`  ${path} (${content.split("\n").length} lines)`));
  for (const item of proposal.evals ?? []) ui.println(ui.dim(`  eval: ${item.prompt.replace(/\s+/g, " ").slice(0, 100)}`));
  for (;;) {
    const answer = await ui.ask("Keep it? [p]roject (.jig/skills) / [u]ser (every project) / [v]iew / [n]o: ", signal);
    const choice = answer?.trim().toLowerCase() ?? "n";
    if (choice.startsWith("p")) return "project";
    if (choice.startsWith("u")) return "user";
    if (!choice.startsWith("v")) return null;
    ui.println(files.get("SKILL.md")!);
  }
}
