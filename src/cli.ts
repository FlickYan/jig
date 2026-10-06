#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type AgentOptions, type AgentUI, formatTokens, runAgent, type RunResult, type ToolHooks } from "./agent.ts";
import { compact } from "./compact.ts";
import { Conversation } from "./conversation.ts";
import { runHooks } from "./hooks.ts";
import { connectMcpServers } from "./mcp.ts";
import { type CallModel, contextWindow, createModel, EFFORTS, type Effort } from "./model.ts";
import { MODE_HELP, MODES, Permissions, type Mode } from "./permissions.ts";
import { loadInstructions, subagentPrompt, systemPrompt } from "./prompt.ts";
import { createSandbox, sandboxProblem } from "./sandbox.ts";
import { SessionFile, sessionDir } from "./session.ts";
import { isTrusted, mergeSettings, needsTrust, readSettings, trust, type Hook, type HookEvent, type Settings } from "./settings.ts";
import { discoverSkills, loadSkill, skillCatalog, skillTool, type Skill } from "./skills.ts";
import { Snapshots } from "./snapshots.ts";
import { Stats } from "./stats.ts";
import { TOOLS, type Tool, type ToolInput } from "./tools/index.ts";
import { subagentTool, type SubagentSetup } from "./tools/subagent.ts";
import * as ui from "./ui.ts";

const HELP = `Usage: jig [options] [task]

Runs one task, or starts an interactive session if no task is given.

Options:
  -m, --model <id>        deepseek-flash (default), deepseek-v4-pro, or a Claude model like claude-opus-5-5
  -e, --effort <level>    ${EFFORTS.join(" | ")} (default: the model's own; DeepSeek takes low | high | max)
      --mode <mode>       when to ask before a tool call (default: edits)
${MODES.map((mode) => `                            ${mode.padEnd(6)} ${MODE_HELP[mode]}`).join("\n")}
  -y, --yes               same as --mode auto
      --no-sandbox        run commands directly on this machine instead of in the sandbox (Seatbelt on
                          macOS, bubblewrap on Linux)
      --allow-network     let sandboxed commands use the network
      --hide-thinking     don't print the model's thinking (/thinking toggles it in a session)
  -c, --continue          continue this project's most recent session
      --resume <file>     continue a saved session (--sessions lists them)
      --sessions          list this project's saved sessions
      --compact-at <n>    summarize the conversation once it reaches n tokens (default: 200000; 0: never)
  -C, --cwd <dir>         project directory (default: the current directory)
      --add-dir <dir>     let the file tools work in this directory too, and the sandbox write there
                          (repeatable; --add-dir / inside a container makes the whole system the project)
      --max-steps <n>     most model calls per task (default: 50)
      --no-subagents      leave out the subagent tool
      --stats <file>      keep a JSON file with the model calls, tokens and tool calls so far
  -h, --help              show this help

jig follows the project's AGENTS.md (or CLAUDE.md), saves every session under ~/.jig/sessions, and
snapshots the project's files before each task so /undo can put them back.

Settings go in ~/.jig/settings.json and the project's .jig/settings.json: allow and deny rules for
commands, hooks around tool calls, and MCP servers. A project's settings can only run programs or
loosen the sandbox once you trust them (JIG_TRUST_PROJECT=1 trusts them without asking, for scripts).
Skills (folders with a SKILL.md) are found in .jig/skills, .agents/skills and .claude/skills, in the
project and in your home directory.
Ctrl+C stops the current task (press it again to force quit).`;

const SUBAGENT_MAX_STEPS = 30;

const COMMANDS = `  /mode [plan|ask|edits|auto]  show or change when jig asks before a tool call
  /undo                        put the files back the way they were before the last task
  /thinking                    show or hide the model's thinking
  /skills                      list the skills; /<skill> [task] runs one
  /mcp                         list the MCP servers and their tools
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
      "add-dir": { type: "string", multiple: true, default: [] },
      "max-steps": { type: "string", default: "50" },
      subagents: { type: "boolean", default: true },
      stats: { type: "string" },
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
  const dirs = values["add-dir"].map((dir) => resolve(dir));
  for (const dir of dirs) if (!existsSync(dir)) throw new Error(`--add-dir: ${dir} doesn't exist`);
  const stats = values.stats ? new Stats(resolve(values.stats), model) : undefined;

  // Flags win over the settings files, which win over the defaults: sandbox on, network off.
  const settings = await loadSettings(cwd);
  const network = values["allow-network"] ?? settings.network ?? false;
  const wantSandbox = values.sandbox ?? settings.sandbox ?? true;
  const sandbox = wantSandbox ? createSandbox(cwd, { network, dirs }) : undefined;
  if (values.sandbox && !sandbox) throw new Error(`No sandbox: ${sandboxProblem()}.`);
  // Said up front, since without the sandbox commands ask first (or, with no one to ask, don't run).
  const noSandbox = wantSandbox && !sandbox ? `No sandbox: ${sandboxProblem()}.` : undefined;
  const contained = !!sandbox && !network;
  const permissions = new Permissions(mode, cwd, { allow: settings.allow, deny: settings.deny, contained, dirs });
  let snapshots: Snapshots | undefined = new Snapshots(cwd);
  // Well before the context window fills: long contexts cost more per step and models use them less well.
  const compactLimit = compactAt && Math.min(compactAt, Math.floor(contextWindow(model) * 0.8));

  // Extensions: skills, the MCP servers' tools, hooks, and subagents.
  const { skills, warnings } = discoverSkills(cwd);
  for (const warning of warnings) ui.notice(warning);
  const mcp = await connectMcpServers(settings.mcpServers, cwd);
  cleanup.push(mcp.close);
  for (const error of mcp.errors) ui.notice(error);
  const hooks = settings.hooks.length ? hookRunner(settings.hooks, cwd) : undefined;
  const extensions = [...(skills.length ? [skillTool(skills)] : []), ...mcp.tools];

  // The system prompt (with the project's instructions) is fixed for a conversation; /reset rebuilds it.
  let instructions = loadInstructions(cwd);
  // Subagents research: they get the tools that only look (and bash, under plan mode's rules), and never ask.
  const research = new Permissions("plan", cwd, { deny: settings.deny, contained, dirs });
  const researchTools = [...TOOLS, ...extensions].filter((tool) => tool.kind === "read" || tool.kind === "run");
  const metered = (callModel: CallModel, subagent = false) => stats?.meter(callModel, { subagent }) ?? callModel;
  const newSubagentModel = () => {
    const system = subagentPrompt(cwd, { instructions, sandboxLimits: sandbox?.limits, dirs });
    return metered(createModel({ model, effort, quiet: true, system, tools: researchTools }), true);
  };
  const subagents: SubagentSetup = {
    callModel: newSubagentModel(),
    tools: researchTools,
    cwd,
    dirs,
    maxSteps: SUBAGENT_MAX_STEPS,
    compactAt: compactLimit,
    async authorize(tool, input) {
      const decision = research.decide(tool, input);
      return decision === "allow" ? null : decision === "ask" ? "Not run: a subagent can't ask the user." : decision.refuse;
    },
    sandbox,
    hooks,
    ui: ui.subagentUI,
  };
  const tools = [...TOOLS, ...(values.subagents ? [subagentTool(subagents)] : []), ...extensions];
  const newModel = () => {
    const system = systemPrompt(cwd, { instructions, sandboxLimits: sandbox?.limits, skills: skillCatalog(skills), dirs });
    return metered(createModel({ model, effort, system, tools }));
  };
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
    tools,
    cwd,
    dirs,
    maxSteps,
    compactAt: compactLimit,
    authorize,
    sandbox,
    hooks,
    ui: stats ? countToolCalls(ui.terminalUI, stats) : ui.terminalUI,
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
      const message = controller.signal.aborted ? "Interrupted." : describeError(err);
      ui.error(message);
      stats?.failed(message);
      return false;
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  function runTask(text: string, label = text): Promise<boolean> {
    if ((permissions.mode === "plan") !== modelKnowsPlanMode) {
      modelKnowsPlanMode = permissions.mode === "plan";
      notes.push(
        modelKnowsPlanMode
          ? "Plan mode is on: you can read, search and run read-only commands, but every change is refused. Investigate, then propose a plan."
          : "Plan mode is off: you can make changes again.",
      );
    }
    takeSnapshot(label);
    const message = notes.length ? `${notes.map((note) => `(Note from jig: ${note})`).join("\n")}\n\n${text}` : text;
    notes.length = 0;
    conversation.push({ role: "user", content: message });
    const started = Date.now();
    return asTask(async (signal) => {
      const result = await runAgent(conversation, agent, signal);
      stats?.finish(result);
      report(result, Date.now() - started, maxSteps);
    });
  }

  /** /<skill> [task]: the user picked the skill, so its instructions come with the request. */
  function runSkill(skill: Skill, task: string): Promise<boolean> {
    const content = loadSkill(skill);
    conversation.pin(`skill:${skill.name}`, content);
    return runTask(`${content}\n\n${task || `Use the ${skill.name} skill.`}`, `/${skill.name} ${task}`);
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
      subagents.callModel = newSubagentModel();
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
    } else if (name === "/skills") {
      if (!skills.length) ui.notice("No skills found. A skill is a folder with a SKILL.md, in .jig/skills, .agents/skills or .claude/skills.");
      for (const skill of skills) ui.println(`  /${skill.name}  ${ui.dim(skill.description)}`);
    } else if (name === "/mcp") {
      if (!Object.keys(settings.mcpServers).length) ui.notice('No MCP servers. Add them under "mcpServers" in jig\'s settings.');
      for (const line of [...mcp.status, ...mcp.errors]) ui.println(`  ${line}`);
      for (const tool of mcp.tools) ui.println(ui.dim(`    ${tool.definition.name}${tool.kind === "read" ? " (read-only)" : ""}`));
    } else if (skills.some((skill) => name === `/${skill.name}`)) {
      await runSkill(skills.find((skill) => name === `/${skill.name}`)!, line.slice(name.length).trim());
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
    if (noSandbox) ui.notice(noSandbox);
    if (!(await runTask(positionals.join(" ")))) process.exitCode = 1;
    return;
  }

  ui.println(`${ui.bold("jig")} ${ui.dim(`· ${model} · effort ${effort ?? "default"} · mode ${mode} · ${cwd}`)}`);
  if (noSandbox) ui.notice(`${noSandbox} Commands run directly on this machine.`);
  else ui.println(ui.dim(sandbox ? `Commands run in the ${sandbox.description}.` : "Commands run directly on this machine (sandbox off)."));
  if (instructions.length) ui.println(ui.dim(`Following ${describeInstructions(instructions)}.`));
  const extras = [
    skills.length && plural(skills.length, "skill") + " (/skills)",
    mcp.tools.length && plural(mcp.tools.length, "MCP tool") + " (/mcp)",
    settings.hooks.length && plural(settings.hooks.length, "hook"),
  ].filter(Boolean);
  if (extras.length) ui.println(ui.dim(`With ${extras.join(", ")}.`));
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

/**
 * The settings in effect: the user's, plus the project's. A repository could run programs through its
 * settings (hooks, MCP servers) or loosen the sandbox, so those parts of a project's settings only apply
 * once the user trusts them, which is asked again whenever the file changes. Deny rules always apply.
 */
async function loadSettings(cwd: string): Promise<Settings> {
  const { user, project } = readSettings(cwd);
  if (!project) return user;
  const asks = needsTrust(project.settings);
  const file = relative(cwd, project.path);
  let trusted = asks.length === 0 || isTrusted(cwd, project) || process.env.JIG_TRUST_PROJECT === "1";
  if (!trusted && process.stdin.isTTY) {
    ui.notice(`This project's ${file} asks jig to:`);
    for (const ask of asks) ui.println(`  - ${ask}`);
    const answer = await ui.ask("Do you trust this project and allow these? [y/N] ");
    trusted = answer?.trim().toLowerCase().startsWith("y") ?? false;
    if (trusted) trust(cwd, project);
  }
  if (!trusted) {
    const how = process.stdin.isTTY ? "" : " Run jig in a terminal to review it, or set JIG_TRUST_PROJECT=1.";
    ui.notice(`Not using ${file} (apart from its deny rules) until you trust it.${how}`);
  }
  return mergeSettings(user, project.settings, trusted);
}

/** The settings' hooks around every tool call. A broken hook is reported to the user and otherwise ignored. */
function hookRunner(hooks: Hook[], cwd: string): ToolHooks {
  const run = async (event: HookEvent, call: Parameters<typeof runHooks>[2]) => {
    const outcome = await runHooks(hooks, event, call, cwd);
    for (const warning of outcome.warnings) ui.notice(warning);
    return outcome;
  };
  return {
    before: async (tool, input) => (await run("PreToolUse", { tool, input })).block ?? null,
    after: async (tool, input, output) => (await run("PostToolUse", { tool, input, output })).feedback ?? null,
  };
}

function countToolCalls(base: AgentUI, stats: Stats): AgentUI {
  return {
    ...base,
    toolCall(name, description, id) {
      stats.toolCall(name);
      base.toolCall(name, description, id);
    },
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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

/** What to shut down before exiting, like the MCP servers. */
const cleanup: Array<() => Promise<void>> = [];

main()
  .catch((err: unknown) => {
    ui.error(describeError(err));
    process.exitCode = 1;
  })
  .finally(() => Promise.allSettled(cleanup.map((close) => close())));
