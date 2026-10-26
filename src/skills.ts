// Agent Skills, as jig uses them: finding the skills a project can see (its own, the user's, jig's), the
// catalog of names and descriptions in the system prompt, and the skill tool that loads the rest only when
// the model asks for it (progressive disclosure). Installing skills is in skill-store.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { jigHome } from "./paths.ts";
import type { Tool } from "./tools/index.ts";
import { assertVisible, isInside, readRegularFile } from "./tools/util.ts";

/** An Agent Skill (agentskills.io): a directory with a SKILL.md of instructions, and maybe scripts and references. */
export interface Skill {
  name: string;
  description: string;
  /** The skill's directory, which holds SKILL.md. */
  dir: string;
  /** Where it was found: the project's skill directories, the user's, or the ones that come with jig. */
  scope: SkillScope;
}

/** Where a skill was found, which also decides which wins when two have the same name. */
export type SkillScope = "project" | "user" | "builtin";

// jig's own directory, the cross-client .agents convention, and Claude Code's, where many skills live.
const SKILL_DIRS = [".jig/skills", ".agents/skills", ".claude/skills"];
const MAX_FILE_CHARS = 30_000;
const MAX_RESOURCES = 50;

/** The skills that come with jig: skills/ beside src/ (or dist/, in the package). */
export const BUILTIN_SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** Where `jig skills add` puts a user's skills: $JIG_HOME/skills, which is ~/.jig/skills unless JIG_HOME says. */
export function userSkillsDir(): string {
  return join(jigHome(), "skills");
}

/** Which skills discoverSkills leaves out. */
export interface DiscoverOptions {
  /** The directory of jig's own skills; null leaves them out (for tests). */
  builtin?: string | null;
  /** Skills to leave out by name (--hide-skill), as if they weren't installed. */
  hidden?: string[];
}

/**
 * The skills available in a project: under the project's skill directories, then the user's, then jig's
 * own. A project skill wins over a user skill of the same name, and either over one of jig's. Like the
 * integration guide suggests, problems are warnings, not errors; only a skill without a description is
 * skipped, since the model couldn't know when to use it. So is one whose SKILL.md isn't a regular file:
 * a project's skills are within a command's reach, and a named pipe there would hang jig (see readRegularFile).
 */
export function discoverSkills(root: string, home = homedir(), { builtin = BUILTIN_SKILLS, hidden = [] }: DiscoverOptions = {}): { skills: Skill[]; warnings: string[] } {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];
  const user = [...new Set([userSkillsDir(), ...SKILL_DIRS.map((sub) => join(home, sub))])];
  const places: [string, SkillScope][] = [
    ...SKILL_DIRS.map((sub): [string, SkillScope] => [join(root, sub), "project"]),
    ...user.map((dir): [string, SkillScope] => [dir, "user"]),
    ...(builtin ? [[builtin, "builtin"] as [string, SkillScope]] : []),
  ];
  for (const [dir, scope] of places.filter(([d]) => existsSync(d) && statSync(d).isDirectory())) {
    for (const entry of readdirSync(dir).sort()) {
      const skillDir = join(dir, entry);
      const file = join(skillDir, "SKILL.md");
      const text = readRegularFile(file);
      if (text === undefined) {
        // A folder without one isn't a skill; one that is a named pipe, say, is left out unread.
        if (existsSync(file)) warnings.push(`Skipped the skill in ${skillDir}: its SKILL.md isn't a regular file.`);
        continue;
      }
      const { name = entry, description } = frontmatter(text);
      if (hidden.includes(name)) continue;
      if (!description) {
        warnings.push(`Skipped the skill in ${skillDir}: its SKILL.md has no description.`);
      } else if (skills.has(name)) {
        if (scope !== "builtin") warnings.push(`The skill "${name}" in ${skillDir} is hidden by the one in ${skills.get(name)!.dir}.`);
      } else {
        if (name !== entry) warnings.push(`The skill "${name}" is in a directory named "${entry}"; they should match.`);
        skills.set(name, { name, description, dir: skillDir, scope });
      }
    }
  }
  return { skills: [...skills.values()], warnings };
}

/**
 * What is wrong with a skill by the Agent Skills specification: the name (1-64 lowercase letters, digits
 * and single hyphens, matching its directory), the description (1-1024 characters) and compatibility (at
 * most 500). Discovery is lenient; installing and saving a skill check it strictly.
 */
export function skillProblems(skillDir: string): string[] {
  const path = join(skillDir, "SKILL.md");
  if (!existsSync(path)) return [`${skillDir} has no SKILL.md.`];
  const text = readFileSync(path, "utf8");
  const fields = frontmatterFields(text);
  const problems = [...nameProblems(fields.name ?? ""), ...descriptionProblems(fields.description ?? "")];
  if (fields.name && fields.name !== basename(skillDir)) problems.push(`The name "${fields.name}" doesn't match its directory, "${basename(skillDir)}".`);
  if (fields.compatibility && fields.compatibility.length > 500) problems.push("The compatibility field is longer than 500 characters.");
  return problems;
}

/** What is wrong with a skill's name by the specification, if anything. */
export function nameProblems(name: string): string[] {
  if (!name) return ["The skill has no name."];
  if (name.length > 64) return [`The name "${name}" is longer than 64 characters.`];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return [`The name "${name}" may only have lowercase letters, digits and single hyphens between them.`];
  return [];
}

/** What is wrong with a skill's description by the specification, if anything. */
export function descriptionProblems(description: string): string[] {
  if (!description.trim()) return ["The skill has no description, so the model couldn't know when to use it."];
  return description.length > 1024 ? ["The description is longer than 1024 characters."] : [];
}

/**
 * Counts each time a skill's instructions were loaded, in $JIG_HOME/skills-usage.json, so `jig skills list`
 * can show which skills are used and which lie idle. Best effort: a failure to write is ignored.
 */
export function recordSkillUse(name: string, now = new Date()): void {
  const path = join(jigHome(), "skills-usage.json");
  try {
    const usage = skillUsage();
    usage[name] = { loads: (usage[name]?.loads ?? 0) + 1, last: now.toISOString() };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(usage, null, 1)}\n`);
  } catch {
    // statistics only
  }
}

/** How often each skill was loaded, and when last (see recordSkillUse); empty if nothing was recorded. */
export function skillUsage(): Record<string, { loads: number; last: string }> {
  try {
    return JSON.parse(readFileSync(join(jigHome(), "skills-usage.json"), "utf8"));
  } catch {
    return {};
  }
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
      // A file in it, SKILL.md too, can be a link, which a command can make in a project's skill after
      // discovery read it: it is read only where the file tools would read it, not in a hidden path or
      // jig's own directory.
      const assertShown = (path: string, shown: string) => assertVisible(path, shown, ctx.hidden, [ctx.cwd, ...(ctx.dirs ?? [])]);
      if (file) {
        const path = join(skill.dir, file);
        const missing = `The skill "${name}" has no file ${file}.`;
        if (!isInside(skill.dir, path)) throw new Error(missing);
        await assertShown(path, file);
        // Enough bytes for the characters kept: UTF-8 takes 4 bytes a character at most.
        const text = readRegularFile(path, 4 * MAX_FILE_CHARS);
        if (text === undefined) throw new Error(missing);
        return text.slice(0, MAX_FILE_CHARS);
      }
      await assertShown(join(skill.dir, "SKILL.md"), "SKILL.md");
      const content = loadSkill(skill);
      ctx.pin?.(`skill:${name}`, content); // keep the instructions through compaction
      recordSkillUse(name);
      return content;
    },
  };
}

/** A skill's instructions as the model sees them: the SKILL.md body, where it lives, and what else is there. */
export function loadSkill(skill: Skill): string {
  const text = readRegularFile(join(skill.dir, "SKILL.md"));
  if (text === undefined) throw new Error(`The skill "${skill.name}" no longer has a SKILL.md, or it isn't a regular file (a named pipe, say).`);
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const files = listSkillFiles(skill.dir).filter((file) => file !== "SKILL.md");
  const resources = files.length
    ? `\n<skill_resources>\n${files.slice(0, MAX_RESOURCES).join("\n")}${files.length > MAX_RESOURCES ? "\n…" : ""}\n</skill_resources>`
    : "";
  return `<skill_content name="${skill.name}">\n${body}\n\nSkill directory: ${skill.dir}\nPaths in this skill are relative to that directory. Read its files with the skill tool's file parameter, and run its scripts with bash using their full path.${resources}\n</skill_content>`;
}

/** name and description from the YAML frontmatter, read leniently: values may hold unquoted colons. */
export function frontmatter(text: string): { name?: string; description?: string } {
  const fields = frontmatterFields(text);
  return { ...(fields.name && { name: fields.name }), ...(fields.description && { description: fields.description }) };
}

/** The frontmatter's top-level fields as strings (a nested map, like metadata, as its lines joined). */
export function frontmatterFields(text: string): Record<string, string> {
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
    fields[match[1]] = unquote(value);
  }
  return fields;
}

/** A YAML scalar's value: a double-quoted one with its escapes decoded (JSON's are valid YAML), a
 * single-quoted one with '' as a quote, a plain one as it is. */
function unquote(value: string): string {
  if (/^".*"$/s.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return /^'.*'$/s.test(value) ? value.slice(1, -1).replace(/''/g, "'") : value;
}

/** The files of a skill, relative to its folder, leaving out hidden ones (.git, .DS_Store). */
export function listSkillFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.name.startsWith(".")) return [];
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listSkillFiles(path, base) : [relative(base, path)];
    });
}
