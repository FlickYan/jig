import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadMemories, memoryDir } from "./memory.ts";
import * as ui from "./ui.ts";

export const MEMORY_HELP = `Usage: jig memory <command>

  list                    what jig remembers: your memories (every project) and this project's
  show <name>             a memory in full
  remove <name>           forget a memory
      --scope <scope>       user or project, if both have the name
  reflect [focus]         go over your last session here and propose what to remember, and edits to
                          AGENTS.md; you approve each one (--yes keeps them all, for scripts)
  -C, --cwd <dir>         the project (default: the current directory)
  -y, --yes               don't ask before removing

Memories live in ~/.jig/memory (user/, and project/<project>/), one Markdown file each.`;

/** `jig memory <command>`, apart from reflect, which runs the agent (see cli.ts). */
export async function memoryCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      scope: { type: "string" },
      cwd: { type: "string", short: "C", default: "." },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, name] = positionals;
  const project = resolve(values.cwd);
  if (values.help || !command) return console.log(MEMORY_HELP);
  const memories = loadMemories(project);
  if (command === "list") {
    if (!memories.length) return ui.println("No memories yet. In a session, /remember saves one and /reflect proposes some from what was done.");
    for (const scope of ["user", "project"] as const) {
      const listed = memories.filter((memory) => memory.scope === scope);
      if (!listed.length) continue;
      ui.println(ui.bold(scope === "user" ? "Yours (every project)" : "This project's"));
      for (const memory of listed) ui.println(`  ${memory.name}  ${ui.dim(`${memory.description}${memory.updated ? ` · ${memory.updated}` : ""}`)}`);
    }
    return ui.println(ui.dim(`In ${memoryDir("user", project)} and ${memoryDir("project", project)}`));
  }
  if (command === "show" || command === "remove") {
    if (!name) throw new Error(`Usage: jig memory ${command} <name>`);
    const found = memories.filter((memory) => memory.name === name && (!values.scope || memory.scope === values.scope));
    if (!found.length) throw new Error(`There is no memory "${name}". jig memory list shows them.`);
    if (found.length > 1) throw new Error(`Both scopes have a memory "${name}": say which with --scope user or --scope project.`);
    const [memory] = found;
    if (command === "show") return ui.println(`${ui.bold(memory.name)} ${ui.dim(`(${memory.scope}${memory.type ? `, ${memory.type}` : ""}${memory.updated ? `, saved ${memory.updated}` : ""})`)}\n${memory.description}\n\n${memory.body}`);
    if (!values.yes) {
      if (!process.stdin.isTTY) throw new Error("There is no one to ask (no terminal); pass --yes to remove it.");
      if (!(await ui.ask(`Forget "${memory.description}"? [y/N] `))?.trim().toLowerCase().startsWith("y")) return ui.notice("Kept it.");
    }
    rmSync(memory.path);
    return ui.notice(`Forgot ${memory.name}.`);
  }
  throw new Error(`There is no "jig memory ${command}". See jig memory --help.`);
}
