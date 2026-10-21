import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverSkills, skillUsage } from "./skills.ts";
import { testSkill } from "./skill-evals.ts";
import {
  compareSkills,
  describeSkill,
  fetchSource,
  findSkills,
  installedSkills,
  installSkill,
  lockedSource,
  parseSource,
  removeSkill,
  skillDirForChange,
  skillsDir,
  type Fetched,
  type InstallScope,
  type SkillInfo,
} from "./skill-store.ts";
import * as ui from "./ui.ts";

export const SKILLS_HELP = `Usage: jig skills <command>

  list                    the skills this project sees: where each comes from, and how often it was used
  add <source>            install skills from a folder, a git URL, or GitHub as owner/repo/path[@ref]
                            (jig skills add anthropics/skills/skills/pdf)
      --project             into this project's .jig/skills (default: yours, in ~/.jig/skills)
      --skill <name>        only this one of the skills the source holds (repeatable)
      --ref <ref>           the branch, tag or commit (default: the repository's default branch)
      --path <folder>       for a git URL: the folder inside the repository
      --force               replace a skill of the same name
  remove <name>           uninstall a skill added with jig skills add
  update [name...]        fetch installed skills again, and replace the ones that changed
  new <what it is for>    have the model write a new skill with you; you approve it before it is saved
  learn [focus]           turn your last session in this project into a skill, if it holds one
  test <name>             run a skill's evals (evals/evals.json) with the skill and without it
      --attempts <n>        runs of each eval, with and without (default: 1)
      --model <id>          the model to test with (default: deepseek-flash)
  -C, --cwd <dir>         the project (default: the current directory)
  -y, --yes               don't ask before installing, updating or removing`;

/** `jig skills <command>`, apart from new and learn, which run the agent (see cli.ts). */
export async function skillsCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: "boolean", default: false },
      skill: { type: "string", multiple: true, default: [] },
      ref: { type: "string" },
      path: { type: "string" },
      force: { type: "boolean", default: false },
      attempts: { type: "string", default: "1" },
      model: { type: "string", default: "deepseek-flash" },
      api: { type: "string" },
      cwd: { type: "string", short: "C", default: "." },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  const project = resolve(values.cwd);
  const confirm = (question: string) => (values.yes ? Promise.resolve(true) : ask(question));

  if (values.help || !command) return console.log(SKILLS_HELP);
  if (command === "list") return list(project);
  if (command === "add") {
    if (rest.length !== 1) throw new Error("Usage: jig skills add <source>. See jig skills --help.");
    return add(rest[0], { project, scope: values.project ? "project" : "user", only: values.skill, ref: values.ref, path: values.path, force: values.force, confirm });
  }
  if (command === "remove") {
    if (rest.length !== 1) throw new Error("Usage: jig skills remove <name>");
    const skill = installedSkills(project).find((s) => s.name === rest[0]);
    if (!skill) throw new Error(`No skill "${rest[0]}" was installed with jig skills add. (Skills you wrote yourself are folders: delete the folder.)`);
    await skillDirForChange(skill.scope, project, skill.name); // refused before anyone is asked
    if (!(await confirm(`Remove the skill "${skill.name}" (${skill.dir})? [y/N] `))) return ui.notice("Kept it.");
    await removeSkill(skill, project);
    return ui.notice(`Removed ${skill.name}.`);
  }
  if (command === "update") return update(project, rest, confirm);
  if (command === "test") {
    if (rest.length !== 1) throw new Error("Usage: jig skills test <name>");
    const attempts = Number(values.attempts);
    if (!Number.isInteger(attempts) || attempts < 1) throw new Error("--attempts must be a positive integer");
    await testSkill(project, rest[0], { attempts, model: values.model, ...(values.api && { api: values.api }) });
    return;
  }
  throw new Error(`There is no "jig skills ${command}". See jig skills --help.`);
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("There is no one to ask (no terminal); pass --yes to go ahead.");
  return (await ui.ask(question))?.trim().toLowerCase().startsWith("y") ?? false;
}

function list(project: string): void {
  const { skills, warnings } = discoverSkills(project);
  for (const warning of warnings) ui.notice(warning);
  if (!skills.length) return ui.println("No skills yet. Add some with jig skills add, or write one with jig skills new.");
  const installed = new Map(installedSkills(project).map((skill) => [`${skill.scope}:${skill.name}`, skill]));
  const usage = skillUsage();
  const width = Math.max(...skills.map((skill) => skill.name.length));
  for (const skill of skills) {
    const lock = installed.get(`${skill.scope}:${skill.name}`)?.entry;
    const used = usage[skill.name];
    const facts = [
      lock && `from ${lock.source}${lock.commit ? ` @ ${lock.commit.slice(0, 7)}` : ""}`,
      used ? `used ${used.loads} time${used.loads === 1 ? "" : "s"}, last ${used.last.slice(0, 10)}` : "never used",
    ].filter(Boolean);
    ui.println(`  ${skill.scope.padEnd(7)}  ${skill.name.padEnd(width)}  ${short(skill.description, 70)}`);
    ui.println(ui.dim(`  ${" ".repeat(7)}  ${" ".repeat(width)}  ${facts.join(" · ")}`));
  }
}

interface AddOptions {
  project: string;
  scope: InstallScope;
  only: string[];
  ref?: string;
  path?: string;
  force: boolean;
  confirm: (question: string) => Promise<boolean>;
}

async function add(spec: string, { project, scope, only, ref, path, force, confirm }: AddOptions): Promise<void> {
  const source = parseSource(spec, { cwd: project, ref, path });
  if (source.url) ui.notice(`Fetching ${spec}…`);
  const fetched = fetchSource(source);
  try {
    let infos = findSkills(fetched.dir).map(describeSkill);
    if (!infos.length) throw new Error(`${spec} holds no skill (no folder with a SKILL.md).`);
    if (only.length) {
      const missing = only.filter((name) => !infos.some((info) => info.name === name));
      if (missing.length) throw new Error(`${spec} has no skill ${missing.join(", ")}. It has: ${infos.map((info) => info.name).join(", ")}.`);
      infos = infos.filter((info) => only.includes(info.name));
    }
    for (const info of infos) showSkill(info);
    const valid = infos.filter((info) => !info.problems.length);
    if (!valid.length) throw new Error("None of these skills follows the Agent Skills format, so nothing was installed.");
    const where = skillsDir(scope, project);
    for (const info of valid) await skillDirForChange(scope, project, info.name); // refused before anyone is asked
    const what = valid.length === 1 ? `the skill "${valid[0].name}"` : `these ${valid.length} skills`;
    if (!(await confirm(`Install ${what} into ${where}? [y/N] `))) return ui.notice("Nothing installed.");
    for (const info of valid) ui.notice(`Installed ${info.name} in ${await installSkill(info, source, fetched, { scope, project, force })}.`);
    if (valid.some((info) => info.scripts.length)) ui.println(ui.dim("Its scripts run only when the model runs them, in the sandbox and under your permission mode."));
  } finally {
    fetched.cleanup();
  }
}

/** What a skill would bring: shown before it is installed or updated. */
function showSkill(info: SkillInfo): void {
  ui.println(`${ui.bold(info.name)}  ${ui.dim(`${info.files.length} file${info.files.length === 1 ? "" : "s"}${info.license ? ` · license: ${short(info.license, 40)}` : ""}`)}`);
  ui.println(`  ${short(info.description, 200)}`);
  if (info.scripts.length) ui.println(ui.dim(`  scripts: ${info.scripts.slice(0, 6).join(", ")}${info.scripts.length > 6 ? `, and ${info.scripts.length - 6} more` : ""}`));
  for (const problem of info.problems) ui.notice(`  Not installed: ${problem}`);
}

async function update(project: string, names: string[], confirm: (question: string) => Promise<boolean>): Promise<void> {
  const installed = installedSkills(project).filter((skill) => !names.length || names.includes(skill.name));
  const unknown = names.filter((name) => !installed.some((skill) => skill.name === name));
  if (unknown.length) throw new Error(`Not installed with jig skills add: ${unknown.join(", ")}.`);
  if (!installed.length) return ui.println("No skills were installed with jig skills add, so there is nothing to update.");
  const skipped: string[] = [];
  for (const skill of installed) {
    // A skill jig refuses, or can't fetch or install, is skipped with the reason, and the rest are still
    // updated: a command can write the project's lockfile, which is read first, and an entry it put there
    // (a name or a link jig refuses, a source that isn't there, an entry that isn't one) mustn't keep the
    // user's own skills from updating. Having no one to ask still stops it, as it does add and remove.
    let fetched: Fetched | undefined;
    let asking = false;
    try {
      await skillDirForChange(skill.scope, project, skill.name); // refused before it is fetched, or anyone asked
      const source = lockedSource(skill.entry);
      fetched = fetchSource(source);
      const [dir] = findSkills(fetched.dir, 0);
      if (!dir) {
        ui.notice(`${skill.name}: ${skill.entry.source} no longer has the skill's folder (${skill.entry.path}); left as it is.`);
        continue;
      }
      if (skill.entry.commit && fetched.commit === skill.entry.commit) {
        ui.println(`${skill.name}: up to date.`);
        continue;
      }
      const { added, removed, changed } = compareSkills(skill.dir, dir);
      if (!added.length && !removed.length && !changed.length) {
        ui.println(`${skill.name}: up to date.`);
        continue;
      }
      const info = describeSkill(dir);
      showSkill(info);
      ui.println(ui.dim(`  changed: ${[...changed, ...added.map((f) => `+${f}`), ...removed.map((f) => `-${f}`)].join(", ")}`));
      asking = true;
      const yes = await confirm(`Update ${skill.name}? [y/N] `);
      asking = false;
      if (!yes) continue;
      await installSkill(info, { ...source, spec: skill.entry.source }, fetched, { scope: skill.scope, project, force: true });
      ui.notice(`Updated ${skill.name}.`);
    } catch (err) {
      if (asking) throw err;
      ui.notice(`Not updating ${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
      skipped.push(skill.name);
    } finally {
      fetched?.cleanup();
    }
  }
  if (skipped.length) throw new Error(`Not updated, as said above: ${skipped.join(", ")}.`);
}

function short(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
