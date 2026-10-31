import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jigHome, projectDir } from "./paths.ts";
import { type Approve, notApproved } from "./proposals.ts";
import { findSecret } from "./secrets.ts";
import { frontmatterFields, nameProblems } from "./skills.ts";
import type { Tool } from "./tools/index.ts";

// Memory: what jig keeps from one session to the next, each item with the user's approval. User memories
// (how the user likes to work) hold in every project; project memories (facts the code doesn't say) in
// one. Both live under $JIG_HOME, not in the repository, so a cloned project can't bring "memories" with
// it; conventions meant for everyone working on a project belong in its AGENTS.md instead.

export type MemoryScope = "user" | "project";
export const MEMORY_TYPES = ["preference", "feedback", "fact", "reference"] as const;

export interface Memory {
  /** Also the file's name: <name>.md. */
  name: string;
  /** The fact itself, in one line: what later sessions see in the index. */
  description: string;
  type?: string;
  /** When it was last saved, YYYY-MM-DD. */
  updated: string;
  /** The longer text: why it holds and how to apply it. */
  body: string;
  scope: MemoryScope;
  path: string;
}

const MAX_DESCRIPTION = 200;
const MAX_BODY = 3000;
const MAX_INDEX = 100; // memories per scope in the prompt, the most recently saved first

/** Where a scope's memories are. A project is known by its real path, so a symlink to it shares them. */
export function memoryDir(scope: MemoryScope, project: string): string {
  if (scope === "user") return join(jigHome(), "memory", "user");
  return projectDir(join("memory", "project"), project);
}

/** The project's memories, then the user's. A file without a description is left out. */
export function loadMemories(project: string): Memory[] {
  return (["project", "user"] as const).flatMap((scope) => {
    const dir = memoryDir(scope, project);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .flatMap((file) => {
        const text = readFileSync(join(dir, file), "utf8");
        const fields = frontmatterFields(text);
        if (!fields.description) return [];
        const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
        return [{ name: file.slice(0, -3), description: fields.description, ...(fields.type && { type: fields.type }), updated: fields.updated ?? "", body, scope, path: join(dir, file) }];
      });
  });
}

/** The memory section of the system prompt: what memory is for, then the index of both scopes. */
export function memoryPrompt(memories: Memory[], { proposing }: { proposing: boolean }): string {
  if (!memories.length && !proposing) return "";
  const parts = [
    "Memory: notes from earlier sessions, each kept with the user's approval. User memories (how the user likes to work) hold in every project, project memories (facts about this project the code doesn't say) here. They were true when saved: before relying on one that names a file, function, command or flag, check that it still holds. The memory tool shows a memory's full text.",
  ];
  if (proposing) {
    parts.push(
      "When the user asks you to remember something, or corrects how you work in a way that should last, propose a memory with propose_memory: one fact or preference each, its description the fact itself. Don't save what the code, the git history or AGENTS.md already say, what matters only to this task, or anything secret. A convention every agent working here should follow belongs in AGENTS.md: propose that with propose_instructions. If a memory turns out to be wrong, propose to forget or correct it.",
    );
  }
  for (const scope of ["user", "project"] as const) {
    const listed = memories.filter((memory) => memory.scope === scope).sort((a, b) => b.updated.localeCompare(a.updated));
    if (!listed.length) continue;
    const lines = listed.slice(0, MAX_INDEX).map((memory) => `- ${memory.name}: ${memory.description}${memory.updated ? ` (${memory.updated})` : ""}`);
    if (listed.length > MAX_INDEX) lines.push(`- ... and ${listed.length - MAX_INDEX} older ones (jig memory list shows them all)`);
    parts.push(`<memories scope="${scope}">\n${lines.join("\n")}\n</memories>`);
  }
  return parts.join("\n\n");
}

/** Reads a memory in full. The files live outside the project, where the file tools don't reach. */
export function memoryTool(memories: Memory[]): Tool {
  return {
    definition: {
      name: "memory",
      description: "Read the full text of a memory listed in the system prompt: why it holds and how to apply it.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", enum: [...new Set(memories.map((memory) => memory.name))], description: "The memory's name" },
          scope: { type: "string", enum: ["user", "project"], description: "Which one, if both scopes have the name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    kind: "read",
    describe: ({ name }) => String(name),
    async run(input) {
      const { name, scope } = input as { name: string; scope?: MemoryScope };
      const memory = memories.find((m) => m.name === name && (!scope || m.scope === scope));
      if (!memory) throw new Error(`There is no memory "${name}"${scope ? ` in the ${scope} scope` : ""}.`);
      return `${memory.name} (${memory.scope} memory${memory.type ? `, ${memory.type}` : ""}${memory.updated ? `, saved ${memory.updated}` : ""})\n${memory.description}\n\n${memory.body}`;
    },
  };
}

interface MemoryProposal {
  action: "save" | "forget";
  scope: MemoryScope;
  name: string;
  description?: string;
  type?: string;
  body?: string;
  reason?: string;
}

/** Saves, updates or forgets a memory, once the user agrees. */
export function proposeMemoryTool(project: string, approve: Approve, now = () => new Date()): Tool {
  return {
    definition: {
      name: "propose_memory",
      description:
        "Propose to save a memory for later sessions, update one (save with an existing name), or forget one that is " +
        "wrong. The user approves each proposal; nothing is kept otherwise.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["save", "forget"] },
          scope: { type: "string", enum: ["user", "project"], description: "user: holds in every project; project: only here" },
          name: { type: "string", description: "Short and lowercase with hyphens, e.g. make-check" },
          description: { type: "string", description: `The fact itself, in one line (at most ${MAX_DESCRIPTION} characters)` },
          type: { type: "string", enum: [...MEMORY_TYPES] },
          body: { type: "string", description: "Why it holds and how to apply it (optional)" },
          reason: { type: "string", description: "For forget: why it is wrong now" },
        },
        required: ["action", "scope", "name"],
        additionalProperties: false,
      },
    },
    kind: "propose",
    describe: ({ action, name }) => `${action} ${name}`,
    async run(input, ctx) {
      const proposal = input as unknown as MemoryProposal;
      const problems = memoryProblems(proposal);
      if (problems.length) throw new Error(`The memory can't be proposed as it is: ${problems.join(" ")}`);
      const path = join(memoryDir(proposal.scope, project), `${proposal.name}.md`);
      const previous = existsSync(path) ? frontmatterFields(readFileSync(path, "utf8")).description : undefined;
      if (proposal.action === "forget") {
        if (previous === undefined) throw new Error(`There is no ${proposal.scope} memory "${proposal.name}" to forget.`);
        const ok = await approve(`Forget the ${proposal.scope} memory ${proposal.name}?`, `  ${previous}${proposal.reason ? `\n  Why: ${proposal.reason}` : ""}`, ctx.signal);
        if (!ok) return notApproved("forgetting", ctx.signal);
        rmSync(path);
        return `Forgot the ${proposal.scope} memory "${proposal.name}".`;
      }
      const details = [`  ${proposal.description}`, ...(proposal.body ? [indent(proposal.body)] : []), ...(previous !== undefined ? [`  (replaces: ${previous})`] : [])];
      const title = `${previous === undefined ? "Remember" : "Update"} (${proposal.scope}): ${proposal.name}`;
      if (!(await approve(title, details.join("\n"), ctx.signal))) return notApproved("memory", ctx.signal);
      mkdirSync(memoryDir(proposal.scope, project), { recursive: true });
      const updated = now().toLocaleDateString("en-CA");
      const fields = [`name: ${proposal.name}`, `description: ${JSON.stringify(proposal.description!.trim())}`, ...(proposal.type ? [`type: ${proposal.type}`] : []), `updated: ${updated}`];
      writeFileSync(path, `---\n${fields.join("\n")}\n---\n${proposal.body?.trim() ? `\n${proposal.body.trim()}\n` : ""}`);
      return `${previous === undefined ? "Saved" : "Updated"} the ${proposal.scope} memory "${proposal.name}". Later sessions will see it.`;
    },
  };
}

function memoryProblems({ action, scope, name, description = "", type, body = "" }: MemoryProposal): string[] {
  const problems = [...nameProblems(String(name)).map((problem) => problem.replace("The skill", "The memory"))];
  if (scope !== "user" && scope !== "project") problems.push('scope must be "user" or "project".');
  if (action !== "save" && action !== "forget") problems.push('action must be "save" or "forget".');
  if (action === "save") {
    if (!description.trim()) problems.push("A memory needs a description: the fact itself, in one line.");
    if (description.length > MAX_DESCRIPTION) problems.push(`The description is longer than ${MAX_DESCRIPTION} characters; put the rest in body.`);
    if (/\n/.test(description.trim())) problems.push("The description must be one line.");
    if (body.length > MAX_BODY) problems.push(`The body is longer than ${MAX_BODY} characters: a memory is one fact, not a document.`);
    if (type && !(MEMORY_TYPES as readonly string[]).includes(type)) problems.push(`type must be one of: ${MEMORY_TYPES.join(", ")}.`);
    const secret = findSecret(`${description}\n${body}`);
    if (secret) problems.push(`It seems to hold ${secret}; memories must not contain secrets.`);
  }
  return problems;
}

function indent(text: string): string {
  return text.trim().split("\n").map((line) => `  ${line}`).join("\n");
}
