import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Tool } from "./tools/index.ts";
import { isInside } from "./tools/util.ts";

/** An Agent Skill (agentskills.io): a directory with a SKILL.md of instructions, and maybe scripts and references. */
export interface Skill {
  name: string;
  description: string;
  /** The skill's directory, which holds SKILL.md. */
  dir: string;
}

// jig's own directory, the cross-client .agents convention, and Claude Code's, where many skills live.
const SKILL_DIRS = [".jig/skills", ".agents/skills", ".claude/skills"];
const MAX_FILE_CHARS = 30_000;
const MAX_RESOURCES = 50;

/**
 * The skills available in a project: under the project's skill directories, then the user's. A project
 * skill wins over a user skill of the same name. Like the integration guide suggests, problems are warnings,
 * not errors; only a skill without a description is skipped, since the model couldn't know when to use it.
 */
export function discoverSkills(root: string, home = homedir()): { skills: Skill[]; warnings: string[] } {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];
  for (const base of [root, home]) {
    for (const dir of SKILL_DIRS.map((sub) => join(base, sub)).filter((d) => existsSync(d) && statSync(d).isDirectory())) {
      for (const entry of readdirSync(dir).sort()) {
        const skillDir = join(dir, entry);
        if (!existsSync(join(skillDir, "SKILL.md"))) continue;
        const { name = entry, description } = frontmatter(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
        if (!description) {
          warnings.push(`Skipped the skill in ${skillDir}: its SKILL.md has no description.`);
        } else if (skills.has(name)) {
          warnings.push(`The skill "${name}" in ${skillDir} is hidden by the one in ${skills.get(name)!.dir}.`);
        } else {
          if (name !== entry) warnings.push(`The skill "${name}" is in a directory named "${entry}"; they should match.`);
          skills.set(name, { name, description, dir: skillDir });
        }
      }
    }
  }
  return { skills: [...skills.values()], warnings };
}

/** The part of the system prompt that lists the skills: only names and descriptions, about 100 tokens each. */
export function skillCatalog(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const list = skills.map((skill) => `<skill name="${skill.name}">${skill.description}</skill>`).join("\n");
  return `Skills hold instructions for particular kinds of tasks. When a task matches a skill's description, call the skill tool with its name before you start, and follow what it says.\n\n<available_skills>\n${list}\n</available_skills>`;
}

/** Loads a skill's instructions, or one of its files: the second and third steps of progressive disclosure. */
export function skillTool(skills: Skill[]): Tool {
  return {
    definition: {
      name: "skill",
      description:
        "Load the instructions of a skill listed in the system prompt, or one of the files in its directory. " +
        "Call it when a task matches a skill's description, before you start on the task.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", enum: skills.map((skill) => skill.name), description: "The skill's name" },
          file: { type: "string", description: "A file in the skill's directory, like references/guide.md (default: its SKILL.md)" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    kind: "read",
    describe: ({ name, file }) => (file ? `${name}: ${file}` : String(name)),

    async run(input, ctx) {
      const { name, file } = input as { name: string; file?: string };
      const skill = skills.find((s) => s.name === name)!;
      if (file) {
        const path = join(skill.dir, file);
        if (!isInside(skill.dir, path) || !existsSync(path) || statSync(path).isDirectory()) {
          throw new Error(`The skill "${name}" has no file ${file}.`);
        }
        return readFileSync(path, "utf8").slice(0, MAX_FILE_CHARS);
      }
      const content = loadSkill(skill);
      ctx.pin?.(`skill:${name}`, content); // keep the instructions through compaction
      return content;
    },
  };
}

/** A skill's instructions as the model sees them: the SKILL.md body, where it lives, and what else is there. */
export function loadSkill(skill: Skill): string {
  const body = readFileSync(join(skill.dir, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const files = listFiles(skill.dir).filter((file) => file !== "SKILL.md");
  const resources = files.length
    ? `\n<skill_resources>\n${files.slice(0, MAX_RESOURCES).join("\n")}${files.length > MAX_RESOURCES ? "\n…" : ""}\n</skill_resources>`
    : "";
  return `<skill_content name="${skill.name}">\n${body}\n\nSkill directory: ${skill.dir}\nPaths in this skill are relative to that directory. Read its files with the skill tool's file parameter, and run its scripts with bash using their full path.${resources}\n</skill_content>`;
}

/** name and description from the YAML frontmatter, read leniently: values may hold unquoted colons. */
export function frontmatter(text: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return {};
  const fields: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    let value = match[2].trim();
    if (/^[>|][+-]?$/.test(value) || value === "") {
      // A block scalar or a nested map: take the indented lines that follow.
      const more: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      value = value.startsWith("|") ? more.join("\n") : more.join(" ");
    }
    fields[match[1]] = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return { name: fields.name || undefined, description: fields.description || undefined };
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path, base) : [relative(base, path)];
  });
}
