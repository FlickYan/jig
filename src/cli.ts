#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatTokens, runAgent, type AgentOptions, type RunResult } from "./agent.ts";
import { compact } from "./compact.ts";
import { Conversation } from "./conversation.ts";
import { contextWindow, createModel, EFFORTS, type Effort } from "./model.ts";
import { MODE_HELP, MODES, Permissions, type Mode } from "./permissions.ts";
import { loadInstructions, systemPrompt } from "./prompt.ts";
import { createSandbox } from "./sandbox.ts";
import { SessionFile, sessionDir } from "./session.ts";
import { loadSettings } from "./settings.ts";
import { Snapshots } from "./snapshots.ts";
import { TOOLS, type Tool, type ToolInput } from "./tools/index.ts";
import * as ui from "./ui.ts";

const HELP = `Usage: jig [options] [task]

Runs one task, or starts an interactive session if no task is given.

Options:
  -m, --model <id>        deepseek-flash (default), deepseek-v4-pro, or a Claude model like claude-opus-5-5
  -e, --effort <level>    ${EFFORTS.join(" | ")} (default: the model's own; DeepSeek takes low | high | max)
      --mode <mode>       when to ask before a tool call (default: edits)
${MODES.map((mode) => `                            ${mode.padEnd(6)} ${MODE_HELP[mode]}`).join("\n")}
  -y, --yes               same as --mode auto
      --no-sandbox        run commands directly on this machine instead of in the sandbox (macOS)
      --allow-network     let sandboxed commands use the network
      --hide-thinking     don't print the model's thinking (/thinking toggles it in a session)
  -c, --continue          continue this project's most recent session
      --resume <file>     continue a saved session (--sessions lists them)
      --sessions          list this project's saved sessions
      --compact-at <n>    summarize the conversation once it reaches n tokens (default: 200000; 0: never)
  -C, --cwd <dir>         project directory (default: the current directory)
      --max-steps <n>     most model calls per task (default: 50)
  -h, --help              show this help

jig follows the project's AGENTS.md (or CLAUDE.md), saves every session under ~/.jig/sessions, and
snapshots the project's files before each task so /undo can put them back. Allow and deny rules for
commands go in ~/.jig/settings.json or .jig/settings.json.
Ctrl+C stops the current task (press it again to force quit).`;

const COMMANDS = `  /mode [plan|ask|edits|auto]  show or change when jig asks before a tool call
  /undo                        put the files back the way they were before the last task
  /thinking                    show or hide the model's thinking
  /context                     show how much context the conversation takes up
  /compact                     summarize the conversation to free up context
  /reset                       start a new conversation (and reload AGENTS.md)
  /exit                        quit (Ctrl+D works too)`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      model: { type: "string", short: "m", default: "deepseek-flash" },
      effort: { type: "string", short: "e" },
      mode: { type: "string", default: "edits" },
      yes: { type: "boolean", short: "y", default: false },
      sandbox: { type: "boolean" },
      "allow-network": { type: "boolean" },
      "hide-thinking": { type: "boolean", default: false },
      continue: { type: "boolean", short: "c", default: false },
      resume: { type: "string" },
      sessions: { type: "boolean", default: false },
      "compact-at": { type: "string", default: "200000" },
      cwd: { type: "string", short: "C", default: "." },
      "max-steps": { type: "string", default: "50" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const cwd = resolve(values.cwd);
  if (values.sessions) return listSessions(cwd);
  const model = values.model;
  const effort = values.effort as Effort | undefined;
  if (effort && !EFFORTS.includes(effort)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}`);
  const mode = (values.yes ? "auto" : values.mode) as Mode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  const maxSteps = Number(values["max-steps"]);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("--max-steps must be a positive integer");
  const compactAt = Number(values["compact-at"]);
  if (!Number.isInteger(compactAt) || compactAt < 0) throw new Error("--compact-at must be a whole number of tokens");
  ui.setThinkingVisible(!values["hide-thinking"]);

  // Flags win over the settings files, which win over the defaults: sandbox on, network off.
  const settings = loadSettings(cwd);
  const network = values["allow-network"] ?? settings.network ?? false;
  const sandbox = (values.sandbox ?? settings.sandbox ?? true) ? createSandbox(cwd, { network }) : undefined;
  if (values.sandbox && !sandbox) throw new Error("The sandbox is only available on macOS so far.");
  const permissions = new Permissions(mode, cwd, { allow: settings.allow, deny: settings.deny, contained: !!sandbox && !network });
  let snapshots: Snapshots | undefined = new Snapshots(cwd);

  // The system prompt (with the project's instructions) is fixed for a conversation; /reset rebuilds it.
  let instructions = loadInstructions(cwd);
  const newModel = () => createModel({ model, effort, system: systemPrompt(cwd, instructions, sandbox?.limits), tools: TOOLS });
  const resumeFrom = values.resume ? findSession(cwd, values.resume) : values.continue ? SessionFile.list(cwd).at(-1) : undefined;
  if (values.continue && !resumeFrom) throw new Error("There is no saved session in this project to continue.");
  let conversation = resumeFrom
    ? new Conversation(new SessionFile(resumeFrom), SessionFile.load(resumeFrom))
    : new Conversation(SessionFile.create(cwd, model));
  let task: AbortController | undefined; // the running task, so Ctrl+C can stop it
  // Things the model should know before the next request, like an /undo. Plan mode is announced when it
  // starts and ends: the system prompt can't change mid-conversation, so this rides on the user's message.
  const notes: string[] = [];
  let modelKnowsPlanMode = false;

  async function authorize(tool: Tool, input: ToolInput): Promise<string | null> {
    const decision = permissions.decide(tool, input);
    if (decision === "allow") return null;
    if (decision !== "ask") return decision.refuse;
    if (!process.stdin.isTTY) return "Not run: there is no one to approve it (no terminal). The user can allow tool calls with --yes.";
    const always = permissions.alwaysLabel(tool, input);
    const answer = await ui.ask(`  Allow? [y]es / [n]o${always ? ` / [a]lways allow ${always}` : ""}: `);
    if (answer === null) {
      task?.abort(); // Ctrl+C at the prompt stops the whole task
      return "Not run: the user stopped the task.";
    }
    const choice = answer.trim().toLowerCase();
    if (always && choice.startsWith("a")) {
      permissions.allowAlways(tool, input);
      return null;
    }
    return choice.startsWith("y") ? null : "The user declined this tool call. Ask them how they want to proceed.";
  }

  const agent: AgentOptions = {
    callModel: newModel(),
    tools: TOOLS,
    cwd,
    maxSteps,
    // Well before the context window fills: long contexts cost more per step and models use them less well.
    compactAt: compactAt && Math.min(compactAt, Math.floor(contextWindow(model) * 0.8)),
    authorize,
    sandbox,
    ui: ui.terminalUI,
  };

  /** Runs `work` as the current task, so Ctrl+C stops it. */
  async function asTask(work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const controller = (task = new AbortController());
    const onSigint = () => {
      if (controller.signal.aborted) process.exit(130); // second Ctrl+C: give up waiting
      ui.interrupted();
      controller.abort();
    };
    process.on("SIGINT", onSigint);
    try {
      await work(controller.signal);
      return true;
    } catch (err) {
      ui.error(controller.signal.aborted ? "Interrupted." : describeError(err));
      return false;
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  function runTask(text: string): Promise<boolean> {
    if ((permissions.mode === "plan") !== modelKnowsPlanMode) {
      modelKnowsPlanMode = permissions.mode === "plan";
      notes.push(
        modelKnowsPlanMode
          ? "Plan mode is on: you can read, search and run read-only commands, but every change is refused. Investigate, then propose a plan."
          : "Plan mode is off: you can make changes again.",
      );
    }
    takeSnapshot(text);
    const message = notes.length ? `${notes.map((note) => `(Note from jig: ${note})`).join("\n")}\n\n${text}` : text;
    notes.length = 0;
    conversation.push({ role: "user", content: message });
    const started = Date.now();
    return asTask(async (signal) => report(await runAgent(conversation, agent, signal), Date.now() - started, maxSteps));
  }

  function takeSnapshot(label: string): void {
    try {
      snapshots?.take(label.slice(0, 200));
    } catch (err) {
      ui.notice(`Couldn't snapshot the project, so /undo is off: ${(err as Error).message.split("\n")[0]}`);
      snapshots = undefined;
    }
  }

  function undo(): void {
    const restored = snapshots?.undo();
    if (!restored) return ui.notice(snapshots ? "Nothing to undo." : "/undo is off: the project couldn't be snapshotted.");
    const { changed, removed } = restored;
    if (!changed.length && !removed.length) return ui.notice("The last task didn't change any files.");
    ui.notice(`Put back ${changed.length} file${changed.length === 1 ? "" : "s"} and removed ${removed.length} the task had created.`);
    for (const path of changed) ui.println(ui.dim(`  restored ${path}`));
    for (const path of removed) ui.println(ui.dim(`  removed  ${path}`));
    conversation.versions.forget(); // the files are not what the model last saw
    notes.push("The user undid your changes from their previous request: the project's files are back to how they were before it.");
  }

  /** Runs a slash command. Returns false to quit. */
  async function command(line: string): Promise<boolean> {
    const [name, arg] = line.split(/\s+/);
    if (name === "/exit") return false;
    if (name === "/help") {
      ui.println(COMMANDS);
    } else if (name === "/undo") {
      undo();
    } else if (name === "/reset") {
      instructions = loadInstructions(cwd);
      agent.callModel = newModel();
      conversation = new Conversation(SessionFile.create(cwd, model));
      modelKnowsPlanMode = false;
      notes.length = 0;
      ui.notice(`Started a new conversation${instructions.length ? ` (with ${describeInstructions(instructions)})` : ""}.`);
    } else if (name === "/thinking") {
      ui.setThinkingVisible(!ui.thinkingVisible());
      ui.notice(`Thinking is now ${ui.thinkingVisible() ? "shown" : "hidden"}.`);
    } else if (name === "/mode" && arg && !MODES.includes(arg as Mode)) {
      ui.notice(`Unknown mode "${arg}". Choose one of: ${MODES.join(", ")}.`);
    } else if (name === "/mode") {
      if (arg) permissions.mode = arg as Mode;
      ui.notice(`Mode: ${permissions.mode} (${MODE_HELP[permissions.mode]}).`);
    } else if (name === "/context") {
      const limit = agent.compactAt ? `it is compacted at ${formatTokens(agent.compactAt)}` : "automatic compaction is off";
      ui.notice(`The conversation takes up about ${formatTokens(conversation.tokens)} tokens; ${limit}.`);
      ui.println(ui.dim(`Saved in ${conversation.sessionPath}`));
    } else if (name === "/compact") {
      await asTask(async (signal) => {
        ui.notice("Compacting the conversation…");
        const done = await compact(conversation, agent.callModel, { signal });
        ui.notice(done ? `Compacted ${formatTokens(done.before)} tokens into about ${formatTokens(done.after)}.` : "Nothing to compact yet.");
      });
    } else {
      ui.notice(`Unknown command ${name}. Type /help to see the commands.`);
    }
    return true;
  }

  if (positionals.length > 0) {
    if (!(await runTask(positionals.join(" ")))) process.exitCode = 1;
    return;
  }

  ui.println(`${ui.bold("jig")} ${ui.dim(`· ${model} · effort ${effort ?? "default"} · mode ${mode} · ${cwd}`)}`);
  ui.println(ui.dim(sandbox ? `Commands run in the ${sandbox.description}.` : "Commands run directly on this machine (no sandbox)."));
  if (instructions.length) ui.println(ui.dim(`Following ${describeInstructions(instructions)}.`));
  if (resumeFrom) ui.println(ui.dim(`Continuing ${basename(resumeFrom)} (${conversation.messages.length} messages).`));
  ui.println(ui.dim("Type a task and press Enter. /help shows the commands."));
  for (;;) {
    ui.println();
    const line = await ui.ask(ui.bold("> "));
    if (line === null) break;
    const input = line.trim();
    if (input.startsWith("/")) {
      if (!(await command(input))) break;
    } else if (input) {
      await runTask(input);
    }
  }
}

function describeInstructions(instructions: { path: string }[]): string {
  return instructions.map((file) => file.path).join(", ");
}

/** A session given by path, or by file name in the project's session directory. */
function findSession(cwd: string, name: string): string {
  for (const path of [resolve(name), join(sessionDir(cwd), name), join(sessionDir(cwd), `${name}.jsonl`)]) {
    if (existsSync(path)) return path;
  }
  throw new Error(`No session "${name}". Run jig --sessions to list this project's sessions.`);
}

function listSessions(cwd: string): void {
  const files = SessionFile.list(cwd);
  if (files.length === 0) return console.log("No saved sessions for this project yet.");
  for (const file of files.slice(-20)) {
    const request = SessionFile.firstRequest(file).replace(/\s+/g, " ");
    console.log(`${basename(file, ".jsonl")}  ${request.length > 70 ? `${request.slice(0, 70)}…` : request}`);
  }
  console.log("\nContinue one with jig --resume <name>, or the most recent with jig -c.");
}

function report(result: RunResult, ms: number, maxSteps: number): void {
  const notes: Partial<Record<RunResult["stop"], string>> = {
    end_turn: "",
    max_steps: `Stopped after ${maxSteps} steps (raise the limit with --max-steps).`,
    max_tokens: "The reply was cut off at the output limit.",
    model_context_window_exceeded: "The conversation no longer fits in the context window. Use /compact or /reset.",
    refusal: "The model declined this request.",
    interrupted: "Interrupted.",
  };
  const note = notes[result.stop] ?? `Stopped (${result.stop}).`;
  if (note) ui.notice(note);
  // The benchmark runner (bench/run.ts) reads this line, so keep its format.
  const { input, cacheWrite, cacheRead, output } = result.usage;
  const tokensIn = input + cacheWrite + cacheRead;
  ui.println(
    ui.dim(
      `${result.steps} step${result.steps === 1 ? "" : "s"} · ${formatTokens(tokensIn)} tokens in (${formatTokens(cacheRead)} from cache)` +
        ` · ${formatTokens(output)} out · ${(ms / 1000).toFixed(1)}s`,
    ),
  );
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Authentication failed: check DEEPSEEK_API_KEY (DeepSeek models) or ANTHROPIC_API_KEY (Claude models).";
  }
  if (err instanceof Anthropic.APIError) return `API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

main().catch((err: unknown) => {
  ui.error(describeError(err));
  process.exitCode = 1;
});
