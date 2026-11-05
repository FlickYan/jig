#!/usr/bin/env node
// jig's entry point. `jig skills`, `jig memory` and `jig sessions` have modules of their own; anything
// else is an agent session, which run.ts runs once the arguments are read: the task it was given, or an
// interactive session that reads tasks and /commands until /exit or Ctrl+D. jig is the whole process here:
// what run.ts leaves to the CLI is the process's (its title, the task on stdin, its output's stream and
// exit code).

import { resolve } from "node:path";
import { SAME_STEPS } from "./agent.ts";
import { memoryCommand } from "./memory-cli.ts";
import { APIS, EFFORTS } from "./model.ts";
import { MODE_HELP, MODES } from "./permissions.ts";
import { reviewCommand } from "./review-cli.ts";
import { describeError, parseOptions, run } from "./run.ts";
import { listSessions, sessionsCommand } from "./sessions-cli.ts";
import { skillsCommand } from "./skills-cli.ts";
import { VERSION } from "./version.ts";
import { TOOL_NAMES } from "./tools/index.ts";
import * as ui from "./ui.ts";

const HELP = `Usage: jig [options] [task]

Runs one task, or starts an interactive session if no task is given. A task of - is read from stdin.

Options:
  -m, --model <id>        deepseek-flash (default), deepseek-v4-pro, a Claude model like claude-opus-5-5, or
                          a model an OpenAI-compatible API serves (gpt-5, or a local model with --base-url)
      --api <format>      ${APIS.join(" | ")}: the API format (default: anthropic for Claude and DeepSeek
                          models, openai for others; DeepSeek serves both)
      --base-url <url>    the API's address, e.g. http://localhost:11434/v1 for Ollama (default: the
                          provider's own; OPENAI_BASE_URL works too)
  -e, --effort <level>    ${EFFORTS.join(" | ")} (default: medium for Claude models, the model's own
                          for others; DeepSeek takes low | high | max)
      --mode <mode>       when to ask before a tool call (default: edits)
${MODES.map((mode) => `                            ${mode.padEnd(6)} ${MODE_HELP[mode]}`).join("\n")}
  -y, --yes               same as --mode auto
      --approve-via <url> in a task given on the command line or stdin, ask a service where the mode would
                          ask at the terminal: jig writes an approval_request event (see --events) and polls
                          <url>/<id> with the model's API key for the answer (see docs/server.md)
      --approval-timeout <s>
                          deny a tool call --approve-via has no answer for after this long (default: 600)
      --no-sandbox        run commands directly on this machine instead of in the sandbox (Seatbelt on
                          macOS, bubblewrap on Linux)
      --allow-network     let sandboxed commands use the network
      --hide-thinking     don't print the model's thinking (/thinking toggles it in a session)
  -c, --continue          continue this project's most recent session
      --resume <file>     continue a saved session (--sessions lists them)
      --sessions          list this project's saved sessions
      --compact-at <n>    summarize the conversation once it reaches n tokens, or 80% of the model's context
                          window if that is less (default: 200000; 0: never)
  -C, --cwd <dir>         project directory (default: the current directory)
      --add-dir <dir>     let the file tools work in this directory too, and the sandbox write there
                          (repeatable; --add-dir / inside a container makes the whole system the project)
      --max-steps <n>     most steps per task, each a model call that may call tools (default: 50)
      --time-limit <s>    most seconds per task: at the limit jig stops, a model call or command still running
                          included, and --check and --reviewer don't start in its last quarter (default: none)
      --no-budget-notes   don't tell the model what is left of its budget: by default, once half the steps, or
                          half of --time-limit, are used, a note after each step says how many steps it has
                          used and how much time is left, and before its last step that it is the last
      --no-early-budget-notes
                          start the notes only once half the steps or the time are used, without saying what a
                          step is: by default they start once 3 or fewer steps are left, if that comes before
                          half, and each says what a step is: one reply, whose tool calls all run before the
                          next, in the order given (at the same time if none of them runs a command or changes
                          anything)
      --finish-gate       the first time the model says it is done, with a step left, send it back once if it
                          changed files after it last ran anything, or its last test run failed (not in
                          --time-limit's last quarter)
      --no-wrap-up        at --max-steps, stop without one more call (no tools) asking the model what it
                          changed, what it verified and what is left
      --escalate <model>  once a test command the model runs fails, this model takes the steps left
      --no-subagents      leave out the subagent tool
      --tools <names>     give the model only some of jig's tools, comma-separated, e.g. --tools bash
                          (from ${TOOL_NAMES.join(", ")}; default: all)
      --stats <file>      keep a JSON file with the model calls, tokens and tool calls so far, and how often
                          each of jig's mechanisms fired (retries, compactions, the wrap-up, ...)
      --events <file>     write a task's events as JSON lines, as they happen: its start, each step with its
                          tokens, the tool calls and results, the text, the notices and its end (- for stdout,
                          the terminal's output then going to stderr; see the README)
      --hide-skill <name> leave a skill out, as if it weren't installed (repeatable)
      --no-memory         leave out what jig remembers from earlier sessions, and don't offer to remember
      --system-prompt <text>
                          use this system prompt instead of jig's own (--check's instructions, the skills,
                          what jig remembers and the project's AGENTS.md are still added after it)
      --check             in a one-shot run, tell the model nobody can answer and ask it to check its
                          work against the task before it finishes (costs turns; see the README)
      --reviewer <model>  before the task ends, this model checks the work against the task (it can only
                          look) and sends the problems it finds back to the model
      --check-writes      after write_file and edit_file, tell the model of a syntax error the change made
                          (Python, JavaScript, shell and JSON files), and of lines write_file left that look
                          like placeholders for code left out. python3, node and bash check a file only where
                          the model could run them on it unasked: with --yes, --mode auto or /mode auto, in
                          edits mode in the sandbox without the network, or by an allow rule or an [a]lways
                          answer; and not where a deny rule matches the check, a PreToolUse hook covers bash,
                          or --tools leaves it out
      --tolerant-edits    let edit_file apply an old_string that matches one place only once curly quotes,
                          dashes and no-break spaces count as ASCII, or then trailing whitespace doesn't count
      --no-overview       don't give the model, before a task, the project's files with their sizes (in a
                          conversation's first message), and the files the task names as read_file shows them,
                          which then count as read (16 KB each, 32 KB in all, line numbers included); by
                          default each is given where the model's own glob or read_file would show it unasked,
                          so not where --tools leaves that tool out, a deny rule refuses it or a PreToolUse
                          hook covers it
      --no-test-notes     don't say in a command's result when its unittest or pytest run ran no tests: by
                          default a note says so, that the commands after the last runner's && didn't run (not
                          where the command exited with 0 and that && list came last), and for unittest, which
                          folders hold test*.py files but no __init__.py, which its discovery doesn't enter.
                          No note where the command runs another kind of runner too (go test, npm test)
      --keep-inputs       after a command, say in its result when a file that was there before the task is gone
                          or empty, if it was as it was then until the command and no other file in the project
                          holds its bytes, and where a copy of it as it was before the task is: from the task's
                          snapshot, or without git from a store jig keeps at the task's start (20 MB a file,
                          100 MB in all); jig never puts it back itself
  -v, --version           print jig's version
  -h, --help              show this help

jig follows the project's AGENTS.md (or CLAUDE.md), saves every session under ~/.jig/sessions, and
snapshots the project's files before each task so /undo can put them back.

jig skills list | add | remove | update | new | learn | test manages skills (jig skills --help).
jig memory list | show | remove | reflect manages what jig remembers (jig memory --help).
jig sessions list | export lists sessions, or exports them as fine-tuning data (jig sessions --help).
jig review reviews an agent's finished work by running it, in a copy (jig review --help).

Settings go in ~/.jig/settings.json and the project's .jig/settings.json: allow and deny rules for
commands, paths to hide from commands and the file tools (hiddenPaths), hooks around tool calls and
before a task ends, and MCP servers. A project's settings can only run programs or loosen the sandbox
once you trust them (JIG_TRUST_PROJECT=1 trusts them without asking, for scripts).
Skills (folders with a SKILL.md) are found in .jig/skills, .agents/skills and .claude/skills, in the
project and in your home directory.
Ctrl+C stops the current task (press it again to force quit). At the prompt it clears the line, and
pressed twice on an empty one it quits. A paste of several lines is one message, sent with Enter, and a
line ending in \\ goes on in the next. A session can also read its tasks and /commands from a pipe, one
on each line: there a line ending in \\ doesn't go on.

A task given on the command line exits with 0 when the model finished, 1 on an error, 2 when it ran out
of steps (--max-steps), 3 when a reply hit the output limit or the context window, 4 when the model
declined, 5 when tool calls needed approval and there was no terminal to ask (see --yes), 6 when the model
made the same tool calls, with the same results, ${SAME_STEPS} steps in a row, 7 when it reached --time-limit,
8 when the model gave a second reply with no text or tool call, and 130 when interrupted.`;

async function main(argv = process.argv.slice(2)): Promise<void> {
  // The task is in jig's arguments, and models stop programs by matching command lines (pkill -f server.py),
  // which could match jig itself. Where the title can't hide them (under emulation, say), pass the task as -.
  process.title = "jig";
  // `jig skills <command>` manages skills, `jig memory <command>` memories and `jig sessions <command>`
  // sessions; skills new and learn, and memory reflect, run the model, so they carry on below. `jig review`
  // reviews finished work, by running it, on its own (review-cli.ts).
  const skillsVerb = argv[0] === "skills" && (argv[1] === "new" || argv[1] === "learn") ? argv[1] : undefined;
  const memoryVerb = argv[0] === "memory" && argv[1] === "reflect" ? argv[1] : undefined;
  if (argv[0] === "skills" && !skillsVerb) return skillsCommand(argv.slice(1));
  if (argv[0] === "memory" && !memoryVerb) return memoryCommand(argv.slice(1));
  if (argv[0] === "sessions") return sessionsCommand(argv.slice(1));
  if (argv[0] === "review") return reviewCommand(argv.slice(1));
  // With --events -, stdout is for the events alone, so what jig says goes to stderr from here on: its
  // refusals of bad arguments too, those parseOptions makes before it knows where the events go included.
  if (argv.some((arg, i) => arg === "--events=-" || (arg === "--events" && argv[i + 1] === "-"))) ui.toStderr();
  const { values, positionals } = parseOptions(skillsVerb || memoryVerb ? argv.slice(2) : argv);
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.sessions) return listSessions(resolve(values.cwd));
  const given = positionals.join(" ") === "-" ? (await readStdin()).trim() : positionals.join(" ");
  if (positionals.join(" ") === "-" && !given) throw new Error("The task was to come from stdin (jig -), but stdin was empty.");
  ui.setThinkingVisible(!values["hide-thinking"]);
  const outcome = await run(values, { given, skillsVerb, memoryVerb });
  if (outcome) process.exitCode = outcome.exitCode;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((err: unknown) => {
  ui.error(describeError(err));
  process.exitCode = 1;
});
