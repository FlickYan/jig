import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { exampleProblems, exportSession } from "./export.ts";
import { jigHome } from "./paths.ts";
import { SessionFile } from "./session.ts";
import * as ui from "./ui.ts";

export const SESSIONS_HELP = `Usage: jig sessions <command>

  list                    this project's saved sessions (as jig --sessions)
  export                  the sessions as fine-tuning data: a JSON object per line, in the format of
                          OpenAI's chat fine-tuning (the messages, tool calls included, and the tools),
                          with anything that looks like a secret blanked out
      --all                 every project's sessions, not just this one's
  -o, --out <file>          write to a file (default: standard output)
  -C, --cwd <dir>         the project (default: the current directory)

Sessions live in ~/.jig/sessions, a directory per project.`;

/** `jig sessions <command>`. */
export function sessionsCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      cwd: { type: "string", short: "C", default: "." },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command] = positionals;
  const project = resolve(values.cwd);
  if (values.help || !command) return console.log(SESSIONS_HELP);
  if (command === "list") return listSessions(project);
  if (command !== "export") throw new Error(`There is no "jig sessions ${command}". See jig sessions --help.`);

  const root = join(jigHome(), "sessions");
  const files = values.all ? (existsSync(root) ? readdirSync(root).flatMap((dir) => sessionFiles(join(root, dir))) : []) : SessionFile.list(project);
  const lines: string[] = [];
  let unfinished = 0;
  let invalid = 0;
  let incomplete = 0;
  let redacted = 0;
  for (const file of files) {
    const exported = exportSession(file);
    if (!exported) {
      unfinished++;
      continue;
    }
    if (exampleProblems(exported.example).length) {
      invalid++;
      continue;
    }
    lines.push(JSON.stringify(exported.example));
    if (!exported.complete) incomplete++;
    redacted += exported.redacted;
  }
  if (values.out) writeFileSync(values.out, lines.length ? `${lines.join("\n")}\n` : "");
  else if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  const notes = [
    unfinished && `${unfinished} had no finished reply`,
    invalid && `${invalid} had messages in an order a trainer would reject, and were left out`,
    incomplete && `${incomplete} ${incomplete === 1 ? "is" : "are"} from before jig recorded the system prompt and tools, so ${incomplete === 1 ? "it has" : "they have"} neither`,
    redacted && `${redacted} ${redacted === 1 ? "thing" : "things"} that looked like secrets ${redacted === 1 ? "was" : "were"} blanked out`,
  ].filter(Boolean);
  ui.notice(`Exported ${lines.length} of ${files.length} ${files.length === 1 ? "session" : "sessions"}${values.out ? ` to ${values.out}` : ""}${notes.length ? ` (${notes.join("; ")})` : ""}.`);
}

function sessionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

/** The last 20 sessions of a project, with what each began with. */
export function listSessions(cwd: string): void {
  const files = SessionFile.list(cwd);
  if (files.length === 0) return console.log("No saved sessions for this project yet.");
  for (const file of files.slice(-20)) {
    const request = SessionFile.firstRequest(file).replace(/\s+/g, " ");
    console.log(`${basename(file, ".jsonl")}  ${request.length > 70 ? `${request.slice(0, 70)}…` : request}`);
  }
  console.log("\nContinue one with jig --resume <name>, or the most recent with jig -c.");
}
