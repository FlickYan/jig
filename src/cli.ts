#!/usr/bin/env node
// jig's entry point. `jig skills`, `jig memory` and `jig sessions` have modules of their own; anything
// else is an agent session. main() turns the options and settings into what the loop needs (the
// permission policy, the sandbox, the tools: jig's own, subagents, skills, the MCP servers' and the
// proposal tools; then the system prompt and the model) and runs the task it was given, or an interactive
// session that reads tasks and /commands until /exit or Ctrl+D.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type AgentOptions, type AgentUI, formatTokens, type Reviewer, type ReviewVerdict, runAgent, type RunResult, type ToolHooks, type Usage } from "./agent.ts";
import { compact } from "./compact.ts";
import { Conversation } from "./conversation.ts";
import { runHooks } from "./hooks.ts";
import { connectMcpServers } from "./mcp.ts";
import OpenAI from "openai";
import { type Api, APIS, type CallModel, contextWindow, createModel, defaultApi, EFFORTS, type Effort } from "./model.ts";
import { MODE_HELP, MODES, Permissions, type Mode } from "./permissions.ts";
import { loadInstructions, REVIEW, subagentPrompt, systemPrompt } from "./prompt.ts";
import { reviewer } from "./review.ts";
import { createSandbox, sandboxProblem } from "./sandbox.ts";
import { SessionFile, sessionDir } from "./session.ts";
import { reviewCommand } from "./review-cli.ts";
import { listSessions, sessionsCommand } from "./sessions-cli.ts";
import { isTrusted, mergeSettings, needsTrust, readSettings, trust, type Hook, type HookEvent, type Settings } from "./settings.ts";
import { proposeInstructionsTool } from "./instructions-proposals.ts";
import { loadMemories, memoryPrompt, memoryTool, proposeMemoryTool } from "./memory.ts";
import { memoryCommand } from "./memory-cli.ts";
import { terminalApprover } from "./proposals.ts";
import { proposeSkillTool } from "./skill-proposals.ts";
import { discoverSkills, loadSkill, skillCatalog, skillTool, type Skill } from "./skills.ts";
import { skillsCommand } from "./skills-cli.ts";
import { type Restored, Snapshots } from "./snapshots.ts";
import { type Share, Stats } from "./stats.ts";
import { VERSION } from "./version.ts";
import { OutputFiles } from "./tools/bash.ts";
import { parseToolList, selectTools, TOOL_NAMES, type Tool, type ToolInput } from "./tools/index.ts";
import { subagentTool, type SubagentSetup } from "./tools/subagent.ts";
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
      --escalate <model>  once a test command the model runs fails, this model takes the steps left
      --no-subagents      leave out the subagent tool
      --tools <names>     give the model only some of jig's tools, comma-separated, e.g. --tools bash
                          (from ${TOOL_NAMES.join(", ")}; default: all)
      --stats <file>      keep a JSON file with the model calls, tokens and tool calls so far
      --hide-skill <name> leave a skill out, as if it weren't installed (repeatable)
      --no-memory         leave out what jig remembers from earlier sessions, and don't offer to remember
      --system-prompt <text>
                          use this system prompt instead of jig's own (the project's AGENTS.md and the
                          skills are still added after it)
      --check             in a one-shot run, tell the model nobody can answer and ask it to check its
                          work against the task before it finishes (costs turns; see the README)
      --reviewer <model>  before the task ends, this model checks the work against the task (it can only
                          look) and sends the problems it finds back to the model
  -v, --version           print jig's version
  -h, --help              show this help

jig follows the project's AGENTS.md (or CLAUDE.md), saves every session under ~/.jig/sessions, and
snapshots the project's files before each task so /undo can put them back.

jig skills list | add | remove | update | new | learn | test manages skills (jig skills --help).
jig memory list | show | remove | reflect manages what jig remembers (jig memory --help).
jig sessions list | export lists sessions, or exports them as fine-tuning data (jig sessions --help).
jig review reviews an agent's finished work by running it, in a copy (jig review --help).

Settings go in ~/.jig/settings.json and the project's .jig/settings.json: allow and deny rules for
commands, hooks around tool calls, and MCP servers. A project's settings can only run programs or
loosen the sandbox once you trust them (JIG_TRUST_PROJECT=1 trusts them without asking, for scripts).
Skills (folders with a SKILL.md) are found in .jig/skills, .agents/skills and .claude/skills, in the
project and in your home directory.
Ctrl+C stops the current task (press it again to force quit).`;

const SUBAGENT_MAX_STEPS = 30;
// A review reads what the task names and the work touched, not the whole project, and the task's clock runs.
const REVIEW_MAX_STEPS = 12;
const VERDICTS: Record<ReviewVerdict, string> = { approved: "approved", problems: "problems sent back", none: "no verdict" };

const COMMANDS = `  /mode [plan|ask|edits|auto]  show or change when jig asks before a tool call
  /undo                        put the files back the way they were before the last task
  /thinking                    show or hide the model's thinking
  /skills                      list the skills; /<skill> [task] runs one
  /skills new <what it is for> write a new skill with the model; you approve it before it is saved
  /learn [focus]               turn what this conversation did into a skill, if it holds one
  /memory                      list what jig remembers, yours and this project's
  /remember <what>             save something for later sessions (you approve it)
  /reflect [focus]             propose what this conversation should leave behind: memories, AGENTS.md edits
  /mcp                         list the MCP servers and their tools
  /context                     show how much context the conversation takes up
  /compact                     summarize the conversation to free up context
  /reset                       start a new conversation (and reload AGENTS.md)
  /exit                        quit (Ctrl+D works too)`;

/** A new skill, written by the model with skill-writer's instructions and submitted with propose_skill. */
function newSkillTask(what: string, interactive: boolean): string {
  const asking = interactive
    ? "ask me about anything you would otherwise have to guess, "
    : "don't ask questions (no one can answer them now): where you have to assume something, say so in the skill, and ";
  return `Write a new skill: ${what}\n\nFollow the skill-writer skill above. Look at the project as far as the skill depends on it, ${asking}then submit the skill with propose_skill.`;
}

/** /reflect: what this conversation showed that later sessions should know, proposed for the user to approve. */
function reflectTask(focus: string): string {
  return (
    "Look back over this conversation for what later sessions should know, and propose it for the user to approve:\n" +
    "- how the user wants you to work: their preferences, and the corrections they made (user scope if it holds in every project, project scope if only here);\n" +
    "- facts about this project that its code, git history and AGENTS.md don't already say: decisions and their reasons, constraints, what turned out to be tricky;\n" +
    "- conventions every agent working on this project should follow: propose those as an edit to AGENTS.md with propose_instructions, not as memories.\n" +
    "Propose each memory with propose_memory: one fact each, its description the fact itself. Update an existing memory rather than adding a near-duplicate, and forget one that this conversation showed to be wrong. Leave out what matters only to this task, and anything secret. If nothing is worth keeping, say so in one line." +
    (focus ? `\n\nFocus on: ${focus}` : "")
  );
}

/** /remember: one thing the user wants kept. */
function rememberTask(what: string): string {
  return `Remember this for later sessions: ${what}\n\nPropose it with propose_memory: the scope (user if it holds in every project, project if only here), a short name, and a description that states it in one line. If it is a convention every agent working here should follow, propose it for AGENTS.md with propose_instructions instead.`;
}

/** /learn: what the conversation so far did, distilled into a skill if it holds a procedure worth keeping. */
function learnTask(focus: string): string {
  return (
    "Look back over this conversation for a procedure worth keeping: steps that worked, or that had to be found out, " +
    "and that would help with similar tasks later. If there is one, write it up as a skill following the skill-writer " +
    "skill above, and submit it with propose_skill. If nothing here is worth a skill, say so in one line." +
    (focus ? `\n\nFocus on: ${focus}` : "")
  );
}

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
  const { values, positionals } = parseArgs({
    args: skillsVerb || memoryVerb ? argv.slice(2) : argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      model: { type: "string", short: "m", default: "deepseek-flash" },
      api: { type: "string" },
      "base-url": { type: "string" },
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
      escalate: { type: "string" },
      subagents: { type: "boolean", default: true },
      tools: { type: "string" },
      stats: { type: "string" },
      "system-prompt": { type: "string" },
      "hide-skill": { type: "string", multiple: true, default: [] },
      memory: { type: "boolean", default: true },
      check: { type: "boolean", default: false },
      reviewer: { type: "string" },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const cwd = resolve(values.cwd);
  if (values.sessions) return listSessions(cwd);
  const given = positionals.join(" ") === "-" ? (await readStdin()).trim() : positionals.join(" ");
  if (positionals.join(" ") === "-" && !given) throw new Error("The task was to come from stdin (jig -), but stdin was empty.");
  if (skillsVerb === "new" && !given) throw new Error("Usage: jig skills new <what the skill is for>");
  const taskText = skillsVerb === "new" ? newSkillTask(given, false) : skillsVerb === "learn" ? learnTask(given) : memoryVerb ? reflectTask(given) : given;
  // A task on the command line with --check: nobody to talk to, so the model checks its own work.
  // Off by default: on Terminal-Bench it cost 38-65% more without solving more (milestone 9).
  const oneShot = taskText !== "" && values.check;
  if (values.check && values.reviewer) throw new Error("--check and --reviewer both check the work before the task ends: use one.");
  const model = values.model;
  const effort = values.effort as Effort | undefined;
  if (effort && !EFFORTS.includes(effort)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}`);
  const api = (values.api ?? defaultApi(model)) as Api;
  if (!APIS.includes(api)) throw new Error(`--api must be one of: ${APIS.join(", ")}`);
  const baseURL = values["base-url"];
  const mode = (values.yes ? "auto" : values.mode) as Mode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  const maxSteps = Number(values["max-steps"]);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("--max-steps must be a positive integer");
  const compactAt = Number(values["compact-at"]);
  if (!Number.isInteger(compactAt) || compactAt < 0) throw new Error("--compact-at must be a whole number of tokens");
  ui.setThinkingVisible(!values["hide-thinking"]);
  const dirs = values["add-dir"].map((dir) => resolve(dir));
  for (const dir of dirs) if (!existsSync(dir)) throw new Error(`--add-dir: ${dir} doesn't exist`);
  const toolNames = values.tools === undefined ? undefined : parseToolList(values.tools);
  const stats = values.stats ? new Stats(resolve(values.stats), model) : undefined;

  // Flags win over the settings files, which win over the defaults: sandbox on, network off.
  const settings = await loadSettings(cwd);
  const network = values["allow-network"] ?? settings.network ?? false;
  const wantSandbox = values.sandbox ?? settings.sandbox ?? true;
  const sandbox = wantSandbox ? createSandbox(cwd, { network, dirs, hidden: settings.hiddenPaths }) : undefined;
  if (values.sandbox && !sandbox) throw new Error(`No sandbox: ${sandboxProblem()}.`);
  // Said up front, since without the sandbox commands ask first (or, with no one to ask, don't run).
  const noSandbox = wantSandbox && !sandbox ? `No sandbox: ${sandboxProblem()}.` : undefined;
  // Only the sandbox can hide paths: without it, commands can read everything the user can.
  if (!sandbox && settings.hiddenPaths.length) ui.notice("The settings' hiddenPaths need the sandbox: without it, commands can read them.");
  const contained = !!sandbox && !network;
  const permissions = new Permissions(mode, cwd, { allow: settings.allow, deny: settings.deny, contained, dirs });
  // The whole of a command's output too long to show, for the model to search. Only the main loop's: the
  // subagents work under plan mode's rules, which don't let commands read outside the project.
  const outputs = new OutputFiles();
  process.on("exit", () => outputs.remove()); // on a forced quit (a second Ctrl+C) too
  // A signal ends jig without the exit event, so closing the terminal (SIGHUP) or a kill (SIGTERM) would
  // leave the files behind: they end it with an ordinary exit instead, and the exit code a shell would give.
  for (const signal of ["SIGHUP", "SIGTERM"] as const) process.once(signal, () => process.exit(128 + constants.signals[signal]));
  let snapshots: Snapshots | undefined = new Snapshots(cwd);
  // Well before the context window fills: long contexts cost more per step and models use them less well.
  const compactLimit = compactAt && Math.min(compactAt, Math.floor(contextWindow(model) * 0.8));

  // Extensions: skills, the MCP servers' tools, hooks, and subagents.
  // jig's own skills are for writing skills; a plain one-shot task (a benchmark's, say) sees only yours.
  const skillOptions = { hidden: values["hide-skill"], ...(taskText && !skillsVerb && { builtin: null }) };
  let { skills, warnings } = discoverSkills(cwd, undefined, skillOptions);
  for (const warning of warnings) ui.notice(warning);
  const mcp = await connectMcpServers(settings.mcpServers, cwd);
  cleanup.push(mcp.close);
  for (const error of mcp.errors) ui.notice(error);
  const hooks = settings.hooks.length ? hookRunner(settings.hooks, cwd) : undefined;
  let extensions = [...(skills.length ? [skillTool(skills)] : []), ...mcp.tools];
  // Memory: notes from earlier sessions (--no-memory leaves them out, for a with-and-without comparison).
  let memories = values.memory ? loadMemories(cwd) : [];
  const proposingMemory = values.memory && (!taskText || !!memoryVerb);
  // What jig may propose about itself: skills in a session or jig skills new and learn; memories and
  // AGENTS.md edits in a session or jig memory reflect. --yes there keeps every proposal, for scripts.
  const approve = terminalApprover({ yes: !!memoryVerb && values.yes });
  const proposals = [
    ...(!taskText || skillsVerb ? [proposeSkillTool()] : []),
    ...(proposingMemory ? [proposeMemoryTool(cwd, approve), proposeInstructionsTool(approve)] : []),
  ];

  // The system prompt (with the project's instructions) is fixed for a conversation; /reset rebuilds it.
  let instructions = loadInstructions(cwd);
  // jig's own tools, unless --tools picks some. The prompts then name only the tools there are.
  const own = selectTools(toolNames);
  const named = (tools: Tool[]) => (toolNames ? tools.map((tool) => tool.definition.name) : undefined);
  // Subagents research: they get the tools that only look (and bash, under plan mode's rules), and never ask.
  const research = new Permissions("plan", cwd, { deny: settings.deny, contained, dirs });
  const researchFrom = (extra: Tool[]) => [...own, ...extra].filter((tool) => tool.kind === "read" || tool.kind === "run");
  let researchTools = researchFrom(extensions);
  const metered = (callModel: CallModel, subagent = false, share?: Share) => stats?.meter(callModel, { subagent, share }) ?? callModel;
  const newSubagentModel = () => {
    const system = subagentPrompt(cwd, { instructions, sandboxLimits: sandbox?.limits, dirs, tools: named(researchTools) });
    return metered(createModel({ model, effort, api, baseURL, quiet: true, system, tools: researchTools }), true);
  };
  const subagents: SubagentSetup = {
    callModel: newSubagentModel(),
    tools: researchTools,
    cwd,
    dirs,
    hidden: settings.hiddenPaths,
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
  // With --reviewer, a subagent on that model reviews the work: the subagents' tools and rules, its own steps.
  const newReviewer = (): Reviewer | undefined => {
    const reviewing = values.reviewer;
    if (!reviewing) return undefined;
    const system = subagentPrompt(cwd, { instructions, sandboxLimits: sandbox?.limits, dirs, tools: named(researchTools) });
    const api = (values.api ?? defaultApi(reviewing)) as Api;
    const callModel = metered(createModel({ model: reviewing, effort, api, baseURL, quiet: true, system, tools: researchTools }), true, { kind: "reviewed", model: reviewing });
    return reviewer(reviewing, { ...subagents, tools: researchTools, callModel, maxSteps: REVIEW_MAX_STEPS });
  };
  const withSubagents = values.subagents && (toolNames?.includes("subagent") ?? true);
  const toolsFrom = (extra: Tool[]) => [
    ...own,
    ...(withSubagents ? [subagentTool(subagents)] : []),
    ...extra,
    ...(memories.length ? [memoryTool(memories)] : []),
    ...proposals,
  ];
  let tools = toolsFrom(extensions);
  // What the model is given besides the messages, for the session to record (see jig sessions export).
  let context: { system: string; tools: Tool["definition"][] } | undefined;
  // With --escalate, the model that takes over: newModel makes it too, with the same system prompt and tools.
  let escalation: AgentOptions["escalate"];
  const newModel = () => {
    const prompt = {
      instructions,
      sandboxLimits: sandbox?.limits,
      skills: skillCatalog(skills),
      memory: memoryPrompt(memories, { proposing: proposingMemory }),
      dirs,
      oneShot,
      tools: named(tools),
      custom: values["system-prompt"],
    };
    const system = systemPrompt(cwd, prompt);
    context = { system, tools: tools.map((tool) => tool.definition) };
    // The same for the model that takes over, so the conversation carries over whole.
    const stronger = values.escalate;
    escalation = stronger
      ? { model: stronger, callModel: metered(createModel({ model: stronger, effort, api: (values.api ?? defaultApi(stronger)) as Api, baseURL, system, tools }), false, { kind: "escalated", model: stronger }) }
      : undefined;
    return metered(createModel({ model, effort, api, baseURL, system, tools }));
  };
  // jig skills learn and jig memory reflect work on the last session, unless --resume names another.
  const fromLast = values.continue || skillsVerb === "learn" || !!memoryVerb;
  const resumeFrom = values.resume ? findSession(cwd, values.resume) : fromLast ? SessionFile.list(cwd).at(-1) : undefined;
  if (values.continue && !resumeFrom) throw new Error("There is no saved session in this project to continue.");
  if ((skillsVerb === "learn" || memoryVerb) && !resumeFrom) throw new Error(`There is no saved session in this project to ${memoryVerb ? "reflect on" : "learn from"}.`);
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
    escalate: escalation,
    tools,
    cwd,
    dirs,
    hidden: settings.hiddenPaths,
    maxSteps,
    compactAt: compactLimit,
    authorize,
    sandbox,
    outputs,
    hooks,
    review: oneShot ? REVIEW : undefined,
    reviewer: newReviewer(),
    ui: stats ? countToolCalls(ui.terminalUI, stats) : ui.terminalUI,
  };
  conversation.describe(context);

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

  /** Writing a skill (/skills new, /learn, jig skills new|learn): with skill-writer's instructions, if it is there. */
  function runSkillWriting(task: string, label: string): Promise<boolean> {
    const writer = skills.find((skill) => skill.name === "skill-writer");
    if (!writer) return runTask(task, label);
    const content = loadSkill(writer);
    conversation.pin(`skill:${writer.name}`, content);
    return runTask(`${content}\n\n${task}`, label);
  }

  /** Finds the skills and memories again (new ones may have been saved) and gives the model the new lists. */
  function refreshSkills(): void {
    ({ skills } = discoverSkills(cwd, undefined, skillOptions));
    memories = values.memory ? loadMemories(cwd) : [];
    extensions = [...(skills.length ? [skillTool(skills)] : []), ...mcp.tools];
    researchTools = researchFrom(extensions);
    tools = toolsFrom(extensions);
    agent.tools = tools;
    subagents.tools = researchTools;
    agent.reviewer = newReviewer();
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
    let restored: Restored | undefined;
    try {
      restored = snapshots?.undo();
    } catch (err) {
      // A git failure (a lock another git left, say) is no reason to end the session.
      return ui.notice(`Couldn't undo (the snapshot is kept for another /undo): ${(err as Error).message.split("\n")[0]}`);
    }
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
      refreshSkills();
      agent.callModel = newModel();
      agent.escalate = escalation;
      subagents.callModel = newSubagentModel();
      conversation = new Conversation(SessionFile.create(cwd, model));
      conversation.describe(context);
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
    } else if (name === "/skills" && arg === "new") {
      const what = line.slice(line.indexOf("new") + 3).trim();
      if (!what) ui.notice("Say what the skill is for: /skills new <what it is for>");
      else await runSkillWriting(newSkillTask(what, true), line);
    } else if (name === "/learn") {
      await runSkillWriting(learnTask(line.slice(name.length).trim()), line);
    } else if (name === "/reflect") {
      await runTask(reflectTask(line.slice(name.length).trim()), line);
    } else if (name === "/remember") {
      const what = line.slice(name.length).trim();
      if (!what) ui.notice("Say what to remember: /remember <what>");
      else await runTask(rememberTask(what), line);
    } else if (name === "/memory") {
      const now = loadMemories(cwd);
      if (!now.length) ui.notice("Nothing remembered yet. /remember saves something; /reflect proposes what this conversation should leave behind.");
      for (const memory of now) ui.println(`  ${memory.name}  ${ui.dim(`${memory.description} (${memory.scope}${memory.updated ? `, ${memory.updated}` : ""})`)}`);
      if (now.length !== memories.length) ui.println(ui.dim("New memories are in the model's view from the next session (or after /reset)."));
    } else if (name === "/skills") {
      if (!skills.length) ui.notice("No skills found. A skill is a folder with a SKILL.md, in .jig/skills, .agents/skills or .claude/skills.");
      for (const skill of skills) ui.println(`  /${skill.name}  ${ui.dim(`${skill.description}${skill.scope === "project" ? "" : ` (${skill.scope})`}`)}`);
      ui.println(ui.dim("/skills new <what it is for> writes a new one; jig skills add installs one."));
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

  if (taskText) {
    if (noSandbox) ui.notice(noSandbox);
    const run = skillsVerb ? runSkillWriting(taskText, `jig skills ${skillsVerb} ${given}`) : runTask(taskText, memoryVerb ? `jig memory reflect ${given}` : taskText);
    if (!(await run)) process.exitCode = 1;
    return;
  }

  const through = api === defaultApi(model) && !baseURL ? "" : ` (${api} API${baseURL ? ` at ${baseURL}` : ""})`;
  ui.println(`${ui.bold("jig")} ${ui.dim(`· ${model}${through} · effort ${effort ?? "default"} · mode ${mode} · ${cwd}`)}`);
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
  // The benchmark runner (bench/run.ts) reads these lines, so keep their format.
  const tokens = (usage: Usage) => `${formatTokens(usage.input + usage.cacheWrite + usage.cacheRead)} tokens in (${formatTokens(usage.cacheRead)} from cache) · ${formatTokens(usage.output)} out`;
  if (result.escalated) ui.println(ui.dim(`Escalated to ${result.escalated.model} at step ${result.escalated.step}: ${tokens(result.escalated.usage)}`));
  if (result.reviewed) {
    const { model, step, verdict, usage } = result.reviewed;
    ui.println(ui.dim(`Reviewed by ${model} after step ${step}: ${VERDICTS[verdict]} · ${tokens(usage)}`));
  }
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
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return "Authentication failed: check DEEPSEEK_API_KEY (DeepSeek models), ANTHROPIC_API_KEY (Claude models) or OPENAI_API_KEY (others).";
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) return `API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
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
