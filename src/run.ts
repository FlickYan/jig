// What jig runs, for the CLI (cli.ts) and for a program that runs it as a library (lib.ts), so the two
// can't drift: main's work once the arguments are read. It turns the options and settings into what the
// loop needs (the permission policy, the sandbox, the tools: jig's own, subagents, skills, the MCP servers'
// and the proposal tools; then the system prompt and the model) and runs the task it was given, or an
// interactive session that reads tasks and /commands until /exit or Ctrl+D. The CLI is the whole process:
// it takes Ctrl+C and the signals that end it, and asks at the terminal. A library's task is one of perhaps
// several in the process, which it leaves alone: it prints nothing, keeps jig's directory and its commands'
// environment in a context of its own (context.ts), is stopped by its signal and asks its approver.

import Anthropic from "@anthropic-ai/sdk";
import { AsyncResource } from "node:async_hooks";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { type Answer, httpApprover } from "./approvals.ts";
import { AFTER_EMPTY, type AgentOptions, type AgentUI, formatTokens, type Reviewer, type ReviewVerdict, runAgent, type RunResult, SAME_STEPS, type ToolHooks, type Usage } from "./agent.ts";
import { compact } from "./compact.ts";
import { type Context, context, withContext } from "./context.ts";
import { Conversation } from "./conversation.ts";
import { type End, type Event, Events } from "./events.ts";
import { hooksFor, runHooks, runStopHooks } from "./hooks.ts";
import { Inputs } from "./inputs.ts";
import { connectMcpServers, type McpServers } from "./mcp.ts";
import OpenAI from "openai";
import { type Api, apiKeyFor, APIS, type CallModel, contextWindow, createModel, defaultApi, EFFORTS, type Effort, effortFor } from "./model.ts";
import { MODE_HELP, MODES, Permissions, type Mode } from "./permissions.ts";
import { overview, type Part } from "./overview.ts";
import { type Instructions, loadInstructions, REVIEW, subagentPrompt, systemPrompt } from "./prompt.ts";
import { reviewer } from "./review.ts";
import { createSandbox, lockedGitPaths, sandboxProblem } from "./sandbox.ts";
import { SessionFile, sessionDir } from "./session.ts";
import { isTrusted, mergeSettings, needsTrust, readSettings, trust, type Hook, type HookEvent, type Settings } from "./settings.ts";
import { proposeInstructionsTool } from "./instructions-proposals.ts";
import { loadMemories, memoryPrompt, memoryTool, proposeMemoryTool } from "./memory.ts";
import { terminalApprover } from "./proposals.ts";
import { proposeSkillTool } from "./skill-proposals.ts";
import { discoverSkills, loadSkill, skillCatalog, skillTool, type Skill } from "./skills.ts";
import { type Restored, Snapshots } from "./snapshots.ts";
import { type Mechanism, type Share, Stats } from "./stats.ts";
import { VERSION } from "./version.ts";
import { bashTool, killCommands, OutputFiles, whyStopped } from "./tools/bash.ts";
import { parseToolList, selectTools, type Tool, type ToolInput } from "./tools/index.ts";
import { subagentTool, type SubagentSetup } from "./tools/subagent.ts";
import * as ui from "./ui.ts";

/** How a task ended: as the loop stopped, or "error" if it failed. */
export type Ending = RunResult["stop"] | "error";

/**
 * A one-shot run's exit code, by how its task ended, so a script can tell work the model finished from a
 * task that stopped short: `jig "fix the tests" && git commit` shouldn't commit after the step limit.
 * Any other ending, a failure included, is 1.
 */
export const EXIT_CODES: Partial<Record<Ending, number>> = { end_turn: 0, max_steps: 2, max_tokens: 3, model_context_window_exceeded: 3, refusal: 4, unapproved: 5, loop: 6, time_limit: 7, empty: 8, interrupted: 130 };

// With no terminal, how many tool calls that need approval a task may make before it stops (see authorize),
// and why it stopped, as the calls left in the reply and the user are told.
const MAX_UNAPPROVED = 3;
const NO_APPROVER = `${MAX_UNAPPROVED} tool calls needed approval, and with no terminal there is no one to give it (see --yes)`;

// With --time-limit, the share of it, at the end, in which --check, the reviewer and --finish-gate no longer
// start: what is left must hold the check and the fixes after it, and in milestone 9 --check ran 12 attempts
// into their time limit, against 4 without it.
const CHECK_SHARE = 0.25;
// What a command, a hook or a tool call stopped at --time-limit is said to have been stopped by.
const TIME_UP = "the time limit (--time-limit) was reached";

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
// The command line's options. A library's task starts from their defaults, as a task given on the command
// line would.
const OPTIONS = {
  model: { type: "string", short: "m", default: "deepseek-flash" },
  api: { type: "string" },
  "base-url": { type: "string" },
  effort: { type: "string", short: "e" },
  mode: { type: "string", default: "edits" },
  yes: { type: "boolean", short: "y", default: false },
  "approve-via": { type: "string" },
  "approval-timeout": { type: "string" },
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
  "time-limit": { type: "string" },
  "budget-notes": { type: "boolean", default: true },
  "early-budget-notes": { type: "boolean" },
  "finish-gate": { type: "boolean", default: false },
  "wrap-up": { type: "boolean", default: true },
  escalate: { type: "string" },
  subagents: { type: "boolean", default: true },
  tools: { type: "string" },
  stats: { type: "string" },
  events: { type: "string" },
  "system-prompt": { type: "string" },
  "hide-skill": { type: "string", multiple: true, default: [] },
  memory: { type: "boolean", default: true },
  check: { type: "boolean", default: false },
  reviewer: { type: "string" },
  "check-writes": { type: "boolean", default: false },
  "tolerant-edits": { type: "boolean", default: false },
  overview: { type: "boolean", default: true },
  "test-notes": { type: "boolean", default: true },
  "keep-inputs": { type: "boolean", default: false },
  version: { type: "boolean", short: "v", default: false },
  help: { type: "boolean", short: "h", default: false },
} satisfies ParseArgsOptionsConfig;

/** The command line's options and the words around them, as parseArgs reads them. */
export function parseOptions(args: string[]) {
  return parseArgs({ args, allowPositionals: true, allowNegative: true, options: OPTIONS });
}

export type Values = ReturnType<typeof parseOptions>["values"];

/** What a run is asked: the task as given, if one was, and the `jig skills` or `jig memory` verb it is for. */
export interface Request {
  /** On the command line, on stdin, or to runTask; "" for an interactive session. */
  given: string;
  skillsVerb?: "new" | "learn";
  memoryVerb?: "reflect";
}

/** How a task given on the command line or to runTask ended. */
export interface Outcome {
  stop: Ending;
  exitCode: number;
  /** The final reply's text (at --max-steps, the wrap-up's report). */
  text: string;
  /** What failed, where the task ended with an error. */
  error?: string;
  /** The end event, where there are events. */
  end?: End;
}

/** A tool call that needs approval, put to a library's approver where the CLI would ask at the terminal. */
export interface ApprovalRequest {
  /** "ap_1", "ap_2", ...: unique within the task. */
  id: string;
  step: number;
  tool: string;
  /** What the terminal shows of the call: the command, the file and the diff, ... */
  description: string;
}

/** The answer: allow (once, or with `always` as the terminal's [a]lways) or deny, as the terminal's [n]o. */
export interface Approval {
  decision: "allow" | "deny";
  always?: boolean;
}

export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<Approval>;

/**
 * What a program that runs jig as a library (lib.ts) gives a task in place of the process: its context
 * (jig's directory, its commands' environment, nothing printed), its API key, a signal that stops it, the
 * listener its events go to, and who approves its tool calls.
 */
export interface Library {
  context: Context;
  apiKey?: string;
  signal?: AbortSignal;
  onEvent(event: Event): void;
  approve?: Approver;
}

/** What outlives a run's setup: its events, for the end, and what to shut down after it, like the MCP servers. */
interface State {
  events?: Events;
  cleanup: Array<() => unknown>;
}

/**
 * Runs the task in `request`, or an interactive session, for the CLI or, with `library`, for a library's
 * task. Returns how a task ended (a session returns nothing). An error before the task starts is thrown; one
 * after its start event ends it with an error, which the end event says.
 */
export async function run(values: Values, request: Request, library?: Library): Promise<Outcome | undefined> {
  const state: State = { cleanup: [] };
  const own: Context = { ...library?.context, told: (text) => state.events?.notice(text) };
  return withContext(own, async () => {
    try {
      return await start(values, request, state, library);
    } catch (err) {
      if (!state.events) throw err;
      const error = describeError(err);
      ui.error(error);
      return { stop: "error", exitCode: 1, text: "", error, end: state.events.end("error", 1) };
    } finally {
      await Promise.allSettled(state.cleanup.map(async (close) => close()));
    }
  });
}

/** run's work, in the run's context. */
async function start(values: Values, { given, skillsVerb, memoryVerb }: Request, state: State, library?: Library): Promise<Outcome | undefined> {
  const cwd = resolve(values.cwd);
  // Someone to ask: only the CLI's, at a terminal.
  const terminal = !library && !!process.stdin.isTTY;
  if (skillsVerb === "new" && !given) throw new Error("Usage: jig skills new <what the skill is for>");
  const taskText = skillsVerb === "new" ? newSkillTask(given, false) : skillsVerb === "learn" ? learnTask(given) : memoryVerb ? reflectTask(given) : given;
  // A task on the command line with --check: nobody to talk to, so the model checks its own work.
  // Off by default: on Terminal-Bench it cost 38-65% more without solving more (milestone 9).
  const oneShot = taskText !== "" && values.check;
  if (values.check && values.reviewer) throw new Error("--check and --reviewer both check the work before the task ends: use one.");
  // Only where --early-budget-notes is given: --no-budget-notes alone leaves the early notes, on by default, out too.
  if (values["early-budget-notes"] && !values["budget-notes"]) throw new Error("--early-budget-notes changes the budget notes, which --no-budget-notes leaves out: use one.");
  const model = values.model;
  const effort = values.effort as Effort | undefined;
  if (effort && !EFFORTS.includes(effort)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}`);
  const api = (values.api ?? defaultApi(model)) as Api;
  if (!APIS.includes(api)) throw new Error(`--api must be one of: ${APIS.join(", ")}`);
  const baseURL = values["base-url"];
  // How every model below is reached: a library's task can have a key of its own.
  const reach = { baseURL, apiKey: library?.apiKey };
  const mode = (values.yes ? "auto" : values.mode) as Mode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  const maxSteps = Number(values["max-steps"]);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("--max-steps must be a positive integer");
  const timeLimit = values["time-limit"] === undefined ? undefined : Number(values["time-limit"]);
  if (timeLimit !== undefined && !(timeLimit > 0 && timeLimit * 1000 < 2 ** 31)) throw new Error("--time-limit must be a positive number of seconds, under 24 days");
  const compactAt = Number(values["compact-at"]);
  if (!Number.isInteger(compactAt) || compactAt < 0) throw new Error("--compact-at must be a whole number of tokens");
  // --events: a task's events as JSON lines, for a backend that runs it (see events.ts), or a library's
  // listener. Opened now, before anything runs; only for a task, since a session has no end to report.
  const sink = library?.onEvent ?? (values.events === "-" ? "-" : values.events === undefined ? undefined : resolve(values.events));
  if (sink !== undefined && (!taskText || skillsVerb || memoryVerb)) throw new Error('--events is for a task given on the command line or stdin: jig --events <file> "task".');
  // The misuse of --approve-via first, then what is wrong with its address, timeout or key.
  if (values["approve-via"] !== undefined) {
    if (!taskText || skillsVerb || memoryVerb) throw new Error('--approve-via is for a task given on the command line or stdin: jig --approve-via <url> "task".');
    if (mode === "auto") throw new Error("--approve-via asks before the tool calls the mode doesn't allow, and --yes (--mode auto) allows them all: use one.");
  }
  const viaService = approveVia(values, model, api, library?.apiKey);
  // The service follows the contract: an approval exists once its event is stored, so without the events
  // every call would wait out the timeout.
  if (viaService && sink === undefined) throw new Error("--approve-via tells the service of each call by its approval_request event: give --events too.");
  // Who answers in the terminal's place: a library's approver, or the service. Only the service's timeout
  // answers by "timeout": what else a library's approver returns isn't passed on.
  const asked = library?.approve;
  const approver = asked
    ? async (request: ApprovalRequest, signal: AbortSignal): Promise<Answer> => {
        const answer = await asked(request, signal);
        return { decision: answer?.decision, always: answer?.always };
      }
    : viaService;
  const events = (state.events = sink === undefined ? undefined : new Events(sink, model));
  events?.start({ task: taskText, cwd, model, version: VERSION, limits: { maxSteps, timeLimit: timeLimit ?? null } });
  // Ctrl+C before the first task starts (while the MCP servers connect, say) ends jig as it would without a
  // handler, but through the exit event, so the end is written and the cleanup below runs.
  const beforeTask = () => process.exit(130);
  // What jig cleans up as it exits (below, once there is something), before the end's events: the end waits for
  // a reader that is behind, and the cleanup mustn't wait behind it, to be lost to an orchestrator's SIGKILL.
  const atExit: Array<() => void> = [];
  if (!library) {
    // A task's end is written when it ends: jig exits before that only on a signal or a forced quit
    // (interrupted), or on a failure nothing caught (error), whatever it was doing then.
    process.on("exit", (code) => {
      try {
        for (const clean of atExit) clean();
      } finally {
        events?.end(code >= 128 ? "interrupted" : "error", code);
      }
    });
    // A signal ends jig without the exit event, so closing the terminal (SIGHUP) or a kill (SIGTERM) would
    // leave the files and the commands behind: they end it with an ordinary exit instead, and the exit code a
    // shell would give.
    // One that comes once the end is written (as jig waits for the reader with it) leaves the end's code.
    for (const signal of ["SIGHUP", "SIGTERM"] as const) process.once(signal, () => process.exit(events?.endedWith ?? 128 + constants.signals[signal]));
    process.on("SIGINT", beforeTask);
  }
  const withEvents = (base: AgentUI): AgentUI => events?.ui(base) ?? base;
  const dirs = values["add-dir"].map((dir) => resolve(dir));
  for (const dir of dirs) if (!existsSync(dir)) throw new Error(`--add-dir: ${dir} doesn't exist`);
  const toolNames = values.tools === undefined ? undefined : parseToolList(values.tools);
  const stats = values.stats ? new Stats(resolve(values.stats), model) : undefined;
  // Every model and loop below counts its mechanisms in the stats file as they fire, subagents' included.
  const count = stats && ((event: Mechanism) => stats.count(event));

  // Flags win over the settings files, which win over the defaults: sandbox on, network off.
  const settings = await loadSettings(cwd, terminal);
  const network = values["allow-network"] ?? settings.network ?? false;
  const wantSandbox = values.sandbox ?? settings.sandbox ?? true;
  // On Linux jig holds one PID namespace for the session (see sandbox.ts's Keeper); if it can't, each command
  // gets one of its own, which ends a command's background jobs with the command. Said once, at the first command.
  const onFallback = () =>
    ui.notice("jig couldn't set up one process namespace for the whole session (bubblewrap is too old, or the kernel refused it), so each command gets its own: a job left in the background then ends with the command that started it.");
  const sandbox = wantSandbox ? createSandbox(cwd, { network, dirs, hidden: settings.hiddenPaths, onFallback }) : undefined;
  if (values.sandbox && !sandbox) throw new Error(`No sandbox: ${sandboxProblem()}.`);
  // Said up front, since without the sandbox commands ask first (or, with no one to ask, don't run).
  const noSandbox = wantSandbox && !sandbox ? `No sandbox: ${sandboxProblem()}.` : undefined;
  // Only the sandbox can hide paths: without it, commands can read everything the user can.
  if (!sandbox && settings.hiddenPaths.length) ui.notice("The settings' hiddenPaths need the sandbox: without it, commands can read them.");
  // The file tools run outside the sandbox, so they refuse what it locks in git themselves, with it or without.
  const gitLocked = lockedGitPaths(cwd, dirs);
  const contained = !!sandbox && !network;
  // The whole of a command's output too long to show, for the model to search: the main loop's policy lets
  // commands that only read look at these files, in plan mode too. Only the main loop's: the subagents'
  // policy doesn't know them, so their results don't point to a file their commands couldn't read.
  const outputs = new OutputFiles();
  // --keep-inputs: the files that were there before each task, watched around its commands; its copies go
  // where the long outputs go. Off until benchmarks show whether it helps.
  const inputs = values["keep-inputs"] ? new Inputs(cwd, { hidden: settings.hiddenPaths, outputs, count, notice: ui.notice }) : undefined;
  // When the run ends, the files go, and the session's keeper (sandbox.ts) ends with the whole PID namespace,
  // so a job a command left in the background dies too.
  state.cleanup.push(
    () => sandbox?.close?.(),
    () => outputs.remove(),
    () => inputs?.remove(),
  );
  if (!library) {
    // So too when jig exits before that, on a signal or a forced quit (a second Ctrl+C), and a command still
    // running is killed as Ctrl+C kills it: only bubblewrap's sandbox would otherwise take them down with jig.
    atExit.push(() => {
      killCommands();
      sandbox?.close?.();
      outputs.remove();
      inputs?.remove();
    });
  }
  let snapshots: Snapshots | undefined = new Snapshots(cwd, settings.hiddenPaths);
  // Well before the context window fills: long contexts cost more per step and models use them less well.
  const compactLimit = compactAt && Math.min(compactAt, Math.floor(contextWindow(model) * 0.8));

  // Extensions: skills, the MCP servers' tools, hooks, and subagents.
  // jig's own skills are for writing skills; a plain one-shot task (a benchmark's, say) sees only yours.
  const skillOptions = { hidden: values["hide-skill"], hiddenPaths: settings.hiddenPaths, dirs, ...(taskText && !skillsVerb && { builtin: null }) };
  let { skills, warnings } = discoverSkills(cwd, undefined, skillOptions);
  for (const warning of warnings) ui.notice(warning);
  const mcp = await connectMcpServers(settings.mcpServers, cwd);
  state.cleanup.push(mcp.close);
  for (const error of mcp.errors) ui.notice(error);
  // A deny rule or hook that names a tool still holds once a clash of names has added a hash to it.
  const deny = [...settings.deny, ...[...mcp.renamed].filter(([, { was }]) => settings.deny.includes(was)).map(([name]) => name)];
  const permissions = new Permissions(mode, cwd, { allow: settings.allow, deny, contained, dirs, outputs });
  const hooks = settings.hooks.length ? hookRunner(settings.hooks, cwd, mcp.renamed) : undefined;
  // The files the task changed, for the Stop hooks: by the snapshot taken before it, while /undo works.
  const changedFiles = () => {
    try {
      return snapshots?.changed();
    } catch {
      return undefined;
    }
  };
  const stopHooks = settings.hooks.some((hook) => hook.event === "Stop") ? stopHookRunner(settings.hooks, cwd, changedFiles) : undefined;
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
  let instructions = followedInstructions(cwd);
  // jig's own tools, unless --tools picks some. The prompts then name only the tools there are.
  const own = selectTools(toolNames);
  const named = (tools: Tool[]) => (toolNames ? tools.map((tool) => tool.definition.name) : undefined);
  // Subagents research: they get the tools that only look (and bash, under plan mode's rules), and never ask.
  const research = new Permissions("plan", cwd, { deny, contained, dirs });
  const researchFrom = (extra: Tool[]) => [...own, ...extra].filter((tool) => tool.kind === "read" || tool.kind === "run");
  let researchTools = researchFrom(extensions);
  const metered = (callModel: CallModel, subagent = false, share?: Share) => {
    const counted = stats?.meter(callModel, { subagent, share }) ?? callModel;
    // Those of a subagent or the reviewer are no step's: the events say whose they are.
    return events?.meter(counted, share?.model ?? model, subagent ? (share?.kind === "reviewed" ? "review" : "subagent") : undefined) ?? counted;
  };
  const newSubagentModel = () => {
    const system = subagentPrompt(cwd, { instructions, sandboxLimits: sandbox?.limits, dirs, tools: named(researchTools) });
    return metered(createModel({ model, effort, api, ...reach, quiet: true, system, tools: researchTools, count }), true);
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
    count,
    ui: ui.subagentUI,
  };
  // With --reviewer, a subagent on that model reviews the work: the subagents' tools and rules, its own steps.
  const newReviewer = (): Reviewer | undefined => {
    const reviewing = values.reviewer;
    if (!reviewing) return undefined;
    const system = subagentPrompt(cwd, { instructions, sandboxLimits: sandbox?.limits, dirs, tools: named(researchTools) });
    const api = (values.api ?? defaultApi(reviewing)) as Api;
    const callModel = metered(createModel({ model: reviewing, effort, api, ...reach, quiet: true, system, tools: researchTools, count }), true, { kind: "reviewed", model: reviewing });
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
      ? { model: stronger, callModel: metered(createModel({ model: stronger, effort, api: (values.api ?? defaultApi(stronger)) as Api, ...reach, system, tools, count }), false, { kind: "escalated", model: stronger }) }
      : undefined;
    return metered(createModel({ model, effort, api, ...reach, system, tools, count }));
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
  let unapproved = 0; // the running task's calls that needed approval, with no terminal to ask
  let finished: RunResult | undefined; // how the last task's loop ended
  let failure: string | undefined; // or what it failed with
  let step = 0; // the running task's step, for a library's approver
  let approvals = 0; // the approvals asked of it so far, for their ids
  // Things the model should know before the next request, like an /undo. Plan mode is announced when it
  // starts and ends: the system prompt can't change mid-conversation, so this rides on the user's message.
  const notes: string[] = [];
  let modelKnowsPlanMode = false;

  async function authorize(tool: Tool, input: ToolInput): Promise<string | null> {
    const decision = permissions.decide(tool, input);
    if (decision === "allow") return null;
    if (decision !== "ask") return decision.refuse;
    if (approver) return approval(approver, tool, input);
    if (!terminal) {
      // The model would try call after call that can't run until its steps ran out. It may manage without
      // one or two (a check it can skip), so the task stops at the third.
      count?.("call.unapproved");
      if (++unapproved >= MAX_UNAPPROVED) task?.abort(NO_APPROVER);
      return "Not run: there is no one to approve it (no terminal). The user can allow tool calls with --yes.";
    }
    const always = permissions.alwaysLabel(tool, input);
    // The task stopping (at --time-limit) closes the question unanswered, so it doesn't wait past the limit.
    const signal = task?.signal;
    const answer = await ui.ask(`  Allow? [y]es / [n]o${always ? ` / [a]lways allow ${always}` : ""}: `, signal);
    if (answer === null) {
      task?.abort(); // Ctrl+C at the prompt stops the whole task
      return `Not run: ${whyStopped(signal, "the user stopped the task")}.`;
    }
    const choice = answer.trim().toLowerCase();
    if (always && choice.startsWith("a")) {
      permissions.allowAlways(tool, input);
      return null;
    }
    return choice.startsWith("y") ? null : "The user declined this tool call. Ask them how they want to proceed.";
  }

  /**
   * A library's approver or --approve-via's service, asked where the terminal would ask, and answered as
   * there: allow is [y]es, allow with `always` [a]lways (where the terminal offers it), deny [n]o. The task
   * stopping (at --time-limit, or by its signal) stops the wait. The events say what was asked, and the
   * answer, with always only where it took effect, as the terminal offers it, unless the task stopped first.
   * An approver that throws leaves the request without an approval: the call fails its permission check.
   */
  async function approval(approve: (request: ApprovalRequest, signal: AbortSignal) => Promise<Answer>, tool: Tool, input: ToolInput): Promise<string | null> {
    const signal = task!.signal;
    const request = { id: `ap_${++approvals}`, step, tool: tool.definition.name, description: tool.describe(input) };
    events?.approvalRequest(request);
    let onAbort = () => {};
    const stopped = new Promise<undefined>((done) => signal.addEventListener("abort", (onAbort = () => done(undefined)), { once: true }));
    const answer = await Promise.race([approve(request, signal), stopped]).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) return `Not run: ${whyStopped(signal, "the task was stopped")}.`;
    const allow = answer?.decision === "allow";
    const always = allow && answer.always === true && permissions.alwaysLabel(tool, input) !== null;
    events?.approval({ id: request.id, decision: allow ? "allow" : "deny", always, by: answer?.by ?? "api" });
    if (!allow) return "The user declined this tool call. Ask them how they want to proceed.";
    if (always) permissions.allowAlways(tool, input);
    return null;
  }

  // --check-writes runs python3, node or bash on a file only where the model could run that program on it
  // itself without asking (see write-check.ts): not without the bash tool, nor where a PreToolUse hook covers
  // bash, as jig can't ask a hook about a command the model didn't make; otherwise where the policy, as it is
  // now, would run `command` unasked and no deny rule matches `script`, what runs in its place. The user is
  // told once why a check was left out; --stats counts each one.
  const bash = bashTool.definition.name;
  const programsOff = !own.some((tool) => tool.definition.name === bash)
    ? "bash isn't among the model's tools"
    : hooksFor(settings.hooks, "PreToolUse", [bash]).length
      ? "a PreToolUse hook covers bash"
      : undefined;
  let toldChecksOff = false;
  function mayRun(command: string, script: string): boolean {
    const decision = permissions.decide(bashTool, { command });
    const why = programsOff ?? (decision === "ask" ? "the model's commands ask first here" : decision !== "allow" || permissions.denies(script) ? "a deny rule refuses it" : undefined);
    if (why && !toldChecksOff) {
      toldChecksOff = true;
      ui.notice(`--check-writes runs python3, node and bash only where the model could run them itself without asking, so it left out a check by ${command.split(" ")[0]}: ${why}.`);
    }
    return !why;
  }

  // --overview gives the model only what its own tools would show it unasked: the list as glob gives it, the
  // named files as read_file shows them. A part is left out where --tools leaves its tool out, a deny rule
  // refuses it, or a PreToolUse hook covers it, as jig can't ask a hook about a call the model didn't make
  // (a PostToolUse hook can't refuse one). The user is told once why a part was left out; --stats counts each
  // task it left one out of.
  const overviewOff = new Map<Part, string>();
  for (const [part, name, what] of [["list", "glob", "the project's files"], ["files", "read_file", "the files the task names"]] as const) {
    const tool = own.find((t) => t.definition.name === name);
    // A tool that only looks is refused only by a deny rule that names it.
    const why = !tool
      ? `${name} isn't among the model's tools`
      : permissions.decide(tool, {}) !== "allow"
        ? `a deny rule refuses ${name}`
        : hooksFor(settings.hooks, "PreToolUse", [name]).length
          ? `a PreToolUse hook covers ${name}`
          : undefined;
    if (why) overviewOff.set(part, `${what} (${why})`);
  }
  const toldOverviewOff = new Set<Part>();

  // What the terminal shows of the main loop, or for a library's task nothing, and the step for its approver.
  const shows = library ? quietUI : ui.terminalUI;
  const base: AgentUI = { ...shows, step: (n, reply) => ((step = n), shows.step?.(n, reply)) };
  const agent: AgentOptions = {
    callModel: newModel(),
    escalate: escalation,
    tools,
    cwd,
    dirs,
    hidden: settings.hiddenPaths,
    gitLocked,
    // Not the subagents' or the reviewer's: they don't change files.
    checkWrites: values["check-writes"],
    // For the model --escalate hands over to too, as the two share these options.
    mayRun,
    tolerantEdits: values["tolerant-edits"],
    // The model --escalate hands over to gets it too; not the subagents, whose plan-mode rules run no tests.
    testNotes: values["test-notes"],
    // Not the subagents', whose commands only look.
    inputs,
    maxSteps,
    compactAt: compactLimit,
    authorize,
    sandbox,
    outputs,
    hooks,
    // Not the subagents' or the reviewer's: their answers don't end the task.
    stopHooks,
    review: oneShot ? REVIEW : undefined,
    reviewer: newReviewer(),
    // The files the task changed, by its snapshot, so that the gate sees what commands changed too.
    finishGate: values["finish-gate"] ? { changed: changedFiles } : undefined,
    wrapUp: values["wrap-up"],
    count,
    ui: withEvents(stats ? countToolCalls(base, stats) : base),
  };
  conversation.describe(context);

  /**
   * Runs `work` as the current task, so Ctrl+C stops it, or a library's signal. Resolves to what `work` does,
   * or to how it failed.
   */
  async function asTask<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | "interrupted" | "error"> {
    const controller = (task = new AbortController());
    const onSigint = () => {
      if (controller.signal.aborted) process.exit(130); // second Ctrl+C: give up waiting
      ui.interrupted();
      controller.abort();
    };
    // In the task's context: the caller aborts from its own, and what the abort sets off is the task's.
    const onAbort = AsyncResource.bind(() => controller.abort());
    if (library?.signal?.aborted) controller.abort();
    library?.signal?.addEventListener("abort", onAbort);
    if (!library) process.off("SIGINT", beforeTask).on("SIGINT", onSigint);
    try {
      return await work(controller.signal);
    } catch (err) {
      const message = controller.signal.aborted ? "Interrupted." : describeError(err);
      ui.error(message);
      if (!controller.signal.aborted) failure = message;
      stats?.failed(message);
      return controller.signal.aborted ? "interrupted" : "error";
    } finally {
      library?.signal?.removeEventListener("abort", onAbort);
      process.off("SIGINT", onSigint);
    }
  }

  /**
   * Runs a task. `words` are the user's own words in it, for --overview to find the files they name; jig's
   * own requests (/reflect, /remember, writing a skill) have none, and get no overview. The loop takes the
   * message without the overview for the task (see AgentOptions.task).
   */
  async function runTask(text: string, label = text, words?: string): Promise<Ending> {
    // --time-limit counts from here, the snapshot and the overview included.
    const begun = Date.now();
    const deadline = timeLimit === undefined ? undefined : begun + timeLimit * 1000;
    const checkUntil = timeLimit === undefined ? undefined : begun + timeLimit * 1000 * (1 - CHECK_SHARE);
    if ((permissions.mode === "plan") !== modelKnowsPlanMode) {
      modelKnowsPlanMode = permissions.mode === "plan";
      notes.push(
        modelKnowsPlanMode
          ? "Plan mode is on: you can read, search and run read-only commands, but every change is refused. Investigate, then propose a plan."
          : "Plan mode is off: you can make changes again.",
      );
    }
    takeSnapshot(label);
    // The loop's note after an empty reply, left last when the previous request ended without an answer:
    // it asks the model to go on with that request, so the model is told it is over.
    const last = conversation.messages.at(-1)?.content;
    if (typeof last === "string" && AFTER_EMPTY.includes(last)) notes.push("Your previous request ended without an answer from you.");
    const told = notes.length ? [notes.map((note) => `(Note from jig: ${note})`).join("\n")] : [];
    notes.length = 0;
    unapproved = 0;
    const ending = await asTask(async (signal) => {
      // At the deadline the task stops as Ctrl+C stops it, a model call or a command still running included,
      // so nothing it does runs on into what comes after it (on Terminal-Bench, the hidden tests).
      const timer = deadline === undefined ? undefined : setTimeout(() => task?.abort(TIME_UP), deadline - Date.now());
      let result: RunResult;
      let started: number;
      try {
        await watchInputs(signal);
        // In the task, so that Ctrl+C and the deadline stop it too: the git that lists the files can wait on a
        // named pipe (a .gitignore, say), for 30 seconds a call.
        const shown = values.overview && words !== undefined ? await overviewFor(words, signal) : undefined;
        const message = [...told, ...(shown ? [shown] : []), text].join("\n\n");
        // The session keeps the request alone too, where the message holds more, for jig sessions list and jig review.
        conversation.push({ role: "user", content: message }, undefined, message === text ? undefined : text);
        started = Date.now();
        // The model --escalate hands over to gets them too: it runs in the same loop.
        const budgetNotes = values["budget-notes"] ? { begun, deadline, early: values["early-budget-notes"] ?? true } : undefined;
        // The task is the message without the overview. A compaction before the first step keeps it in place
        // of the message, so jig's notes, which the model hasn't seen yet, stay in it.
        result = await runAgent(conversation, { ...agent, task: [...told, text].join("\n\n"), checkUntil, budgetNotes }, signal);
        // A listener that threw at the wrap-up's call event, say, after which the loop called it no more.
        events?.check();
      } finally {
        clearTimeout(timer);
      }
      // Stopped by authorize, or by the clock, not by the user. The signal's reason says what stopped it first:
      // after a Ctrl+C the task can still be stopping when the deadline passes.
      if (result.stop === "interrupted" && signal.reason === NO_APPROVER) result.stop = "unapproved";
      if (result.stop === "interrupted" && signal.reason === TIME_UP) result.stop = "time_limit";
      stats?.finish(result);
      // The wrap-up's report, which report() prints, is the model's text after the last step.
      if (result.stop === "max_steps" && result.text.trim()) events?.text(result.text.trim());
      report(result, Date.now() - started, maxSteps);
      finished = result;
      return result.stop;
    });
    // However the task ended: a command may have run before it failed or was stopped.
    warnOfGitChanges();
    return ending;
  }

  /**
   * --overview's text before a task in the user's `words` (see overview.ts): the project's files in a
   * conversation's first message, where the model has none of it yet, and the files the words name, which
   * it records as read; each only where the model's own tools would show it (see overviewOff). Each time it
   * adds something is counted, each named file it shows, and each time it leaves a part out. A project it
   * can't list (one the settings hide, say) gets none, and the user is told why; a task stopped meanwhile
   * (`signal`) gets none either.
   */
  async function overviewFor(words: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const list = conversation.messages.length === 0;
      // The note says that the files shown count as read only where write_file can replace them: where it is
      // among the model's tools, and neither the mode (plan) nor a deny rule refuses it.
      const write = own.find((tool) => tool.definition.name === "write_file");
      const decision = write && permissions.decide(write, {});
      const writable = decision === "allow" || decision === "ask";
      const found = await overview(words, { cwd, dirs, hidden: settings.hiddenPaths, versions: conversation.versions, list, withheld: [...overviewOff.keys()], writable, signal });
      if (!found) return undefined;
      if (found.text) count?.("overview");
      for (let i = 0; i < found.shown; i++) count?.("overview.file");
      if (found.left.length) count?.("overview.skipped");
      const untold = found.left.filter((part) => !toldOverviewOff.has(part));
      for (const part of untold) toldOverviewOff.add(part);
      // On by default, so these name the overview, not a flag the user may never have given.
      if (untold.length) ui.notice(`The overview gives the model only what its own tools would show it unasked, so it left out ${untold.map((part) => overviewOff.get(part)).join(" and ")}. --no-overview turns it off.`);
      return found.text || undefined;
    } catch (err) {
      if (signal.aborted) return undefined;
      ui.notice(`The overview left the project's files out (--no-overview turns it off): ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * --keep-inputs lists the files there before the task, from the snapshot just taken, or without one by
   * keeping them now: in the task, so that Ctrl+C and the deadline stop it. If that fails, the task goes on
   * unwatched, and the user is told why.
   */
  async function watchInputs(signal: AbortSignal): Promise<void> {
    try {
      await inputs?.start(snapshots, signal);
    } catch (err) {
      if (!signal.aborted) ui.notice(`--keep-inputs isn't watching this task's files: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  /**
   * Says which files telling git where its config is commands changed, which git directories they made git
   * pass over, and which directories they made git directories, where the sandbox doesn't stop them.
   */
  function warnOfGitChanges(): void {
    for (const path of sandbox?.gitChanges?.() ?? []) {
      // A commondir or a .git sends git to another git directory's config; a config.worktree adds to the config;
      // without its HEAD, objects and refs in order, git passes over a git directory, to one above it if any;
      // and a directory made a git directory (its path ends in a slash) is the repository git there finds.
      const name = basename(path);
      const [change, effect] = path.endsWith(sep)
        ? [`made ${path.slice(0, -1)} a git directory`, "git there would now take it for its repository"]
        : ["HEAD", "objects", "refs"].includes(name)
          ? [`removed or broke ${path}`, `git no longer takes ${dirname(path)} for a git directory, so it fails there or uses another above it`]
          : [`created or changed ${path}`, name === "config.worktree" ? "git can read more config from it" : "git would now read its config from elsewhere"];
      ui.notice(`A command ${change}, which the sandbox doesn't prevent: ${effect}, and a config can name programs for git to run. Check it before you run git in this repository.`);
    }
  }

  /** /<skill> [task]: the user picked the skill, so its instructions come with the request. */
  async function runSkill(skill: Skill, task: string): Promise<Ending> {
    const content = skillContent(skill);
    if (content === undefined) return "error";
    conversation.pin(`skill:${skill.name}`, content);
    return runTask(`${content}\n\n${task || `Use the ${skill.name} skill.`}`, `/${skill.name} ${task}`, task);
  }

  /** Writing a skill (/skills new, /learn, jig skills new|learn): with skill-writer's instructions, if it is there. */
  function runSkillWriting(task: string, label: string): Promise<Ending> {
    const writer = skills.find((skill) => skill.name === "skill-writer");
    const content = writer && skillContent(writer);
    if (!writer || content === undefined) return runTask(task, label);
    conversation.pin(`skill:${writer.name}`, content);
    return runTask(`${content}\n\n${task}`, label);
  }

  /**
   * A skill's instructions, or a notice and undefined if its SKILL.md is gone (or is a named pipe, or a link
   * where the file tools don't read) since jig found it: a command or a checkout can do that mid-session,
   * and it is no reason to end the session.
   */
  function skillContent(skill: Skill): string | undefined {
    try {
      return loadSkill(skill, settings.hiddenPaths, [cwd, ...dirs]);
    } catch (err) {
      ui.notice((err as Error).message);
      return undefined;
    }
  }

  /**
   * Finds the skills and memories again (new ones may have been saved) and gives the model the new lists,
   * saying why a skill is left out, as at the start: a command can have changed one since.
   */
  function refreshSkills(): void {
    ({ skills, warnings } = discoverSkills(cwd, undefined, skillOptions));
    for (const warning of warnings) ui.notice(warning);
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
      instructions = followedInstructions(cwd);
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
      for (const tool of mcp.tools) {
        const renamed = mcp.renamed.get(tool.definition.name);
        const notes = [...(renamed ? [`from "${renamed.server}"`] : []), ...(tool.kind === "read" ? ["read-only"] : [])];
        ui.println(ui.dim(`    ${tool.definition.name}${notes.length ? ` (${notes.join(", ")})` : ""}`));
      }
    } else if (skills.some((skill) => name === `/${skill.name}`)) {
      await runSkill(skills.find((skill) => name === `/${skill.name}`)!, line.slice(name.length).trim());
    } else if (name === "/context") {
      const limit = agent.compactAt ? `it is compacted at ${formatTokens(agent.compactAt)}` : "automatic compaction is off";
      ui.notice(`The conversation takes up about ${formatTokens(conversation.tokens)} tokens; ${limit}.`);
      ui.println(ui.dim(`Saved in ${conversation.sessionPath}`));
    } else if (name === "/compact") {
      await asTask(async (signal) => {
        ui.notice("Compacting the conversation…");
        const done = await compact(conversation, agent.callModel, { signal }).catch((err: unknown) => {
          throw new Error(`Compaction failed: ${describeError(err)}`); // compact's "the model wrote no summary" doesn't say what failed
        });
        ui.notice(done ? `Compacted ${formatTokens(done.before)} tokens into about ${formatTokens(done.after)}.` : "Nothing to compact yet.");
      });
    } else {
      ui.notice(`Unknown command ${name}. Type /help to see the commands.`);
    }
    return true;
  }

  if (taskText) {
    if (noSandbox) ui.notice(noSandbox);
    const ending = await (skillsVerb
      ? runSkillWriting(taskText, `jig skills ${skillsVerb} ${given}`)
      : memoryVerb
        ? runTask(taskText, `jig memory reflect ${given}`)
        : runTask(taskText, taskText, taskText));
    const exitCode = EXIT_CODES[ending] ?? 1;
    return { stop: ending, exitCode, text: finished?.text ?? "", ...(failure && { error: failure }), end: events?.end(ending, exitCode) };
  }

  const through = api === defaultApi(model) && !baseURL ? "" : ` (${api} API${baseURL ? ` at ${baseURL}` : ""})`;
  ui.println(`${ui.bold("jig")} ${ui.dim(`· ${model}${through} · effort ${effortFor(model, api, effort) ?? "default"} · mode ${mode} · ${cwd}`)}`);
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
    const line = await ui.askTask(ui.bold("> "));
    if (line === null) break;
    const input = line.trim();
    if (input.startsWith("/")) {
      if (!(await command(input))) break;
    } else if (input) {
      await runTask(input, input, input);
    }
  }
  // Once more: a job a command left running in the background may have changed one since the last task.
  warnOfGitChanges();
}

/**
 * The settings in effect: the user's, plus the project's. A repository could run programs through its
 * settings (hooks, MCP servers) or loosen the sandbox, so those parts of a project's settings only apply
 * once the user trusts them, which is asked again whenever the file changes. Deny rules and hidden paths
 * always apply.
 */
async function loadSettings(cwd: string, terminal: boolean): Promise<Settings> {
  const { user, project, warnings } = readSettings(cwd);
  for (const warning of warnings) ui.notice(warning);
  if (!project) return user;
  const asks = needsTrust(project.settings);
  const file = relative(cwd, project.path);
  let trusted = asks.length === 0 || isTrusted(cwd, project) || (context().env ?? process.env).JIG_TRUST_PROJECT === "1";
  if (!trusted && terminal) {
    ui.notice(`This project's ${file} asks jig to:`);
    for (const ask of asks) ui.println(`  - ${ask}`);
    const answer = await ui.ask("Do you trust this project and allow these? [y/N] ");
    trusted = answer?.trim().toLowerCase().startsWith("y") ?? false;
    if (trusted) trust(cwd, project);
  }
  if (!trusted) {
    const how = terminal ? "" : " Run jig in a terminal to review it, or set JIG_TRUST_PROJECT=1.";
    ui.notice(`Not using ${file} (apart from its deny rules and hidden paths) until you trust it.${how}`);
  }
  return mergeSettings(user, project.settings, trusted);
}

/**
 * --approve-via's approver, or undefined without the flag. Refuses an address that isn't http or https, or
 * has credentials (fetch refuses them), a query or a fragment (jig adds /<id>?wait=25 to it), a
 * --approval-timeout (600 seconds by default) that isn't a positive number or comes without it, and a model
 * with no API key to send.
 */
function approveVia(values: Values, model: string, api: Api, apiKey?: string) {
  const url = values["approve-via"];
  const given = values["approval-timeout"];
  if (url === undefined) {
    if (given !== undefined) throw new Error("--approval-timeout is for --approve-via: how long a tool call waits for its answer.");
    return undefined;
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {}
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") throw new Error("--approve-via must be an http or https address, like http://127.0.0.1:8082/internal/approvals");
  // A bare ? or # leaves search and hash empty, but still ends the path.
  if (parsed.username || parsed.password || /[?#]/.test(url)) throw new Error("--approve-via must be an address without credentials, a query or a fragment: jig adds /<id>?wait=25 to it.");
  const timeout = given === undefined ? 600 : Number(given);
  if (!(timeout > 0 && Math.ceil(timeout * 1000) < 2 ** 31)) throw new Error("--approval-timeout must be a positive number of seconds, under 24 days");
  const key = apiKey ?? apiKeyFor(model, api);
  if (!key) throw new Error("--approve-via sends the API key jig uses for the model to the service, and there is none: set DEEPSEEK_API_KEY (DeepSeek models), ANTHROPIC_API_KEY (Claude models) or OPENAI_API_KEY (others).");
  return httpApprover(url, key, timeout, ui.notice);
}

/** The settings' hooks around every tool call. A broken hook is reported to the user and otherwise ignored. */
function hookRunner(hooks: Hook[], cwd: string, renamed: McpServers["renamed"]): ToolHooks {
  const run = async (event: Exclude<HookEvent, "Stop">, call: Parameters<typeof runHooks>[2], signal?: AbortSignal) => {
    const outcome = await runHooks(hooks, event, call, cwd, { signal, was: renamed.get(call.tool)?.was });
    for (const warning of outcome.warnings) ui.notice(warning);
    return outcome;
  };
  return {
    before: async (tool, input, signal) => (await run("PreToolUse", { tool, input }, signal)).block ?? null,
    after: async (tool, input, output, signal) => (await run("PostToolUse", { tool, input, output }, signal)).feedback ?? null,
  };
}

/** The settings' Stop hooks, before a task ends. Likewise, a broken one is reported and otherwise ignored. */
function stopHookRunner(hooks: Hook[], cwd: string, changedFiles: () => string[] | undefined): AgentOptions["stopHooks"] {
  return async ({ task, answer, active, session }, signal) => {
    const stop = { task, last_message: answer, stop_hook_active: active, session_path: session, changed_files: changedFiles() };
    const outcome = await runStopHooks(hooks, stop, cwd, { signal });
    for (const warning of outcome.warnings) ui.notice(warning);
    return outcome.block ?? null;
  };
}

/** A library's task's main loop shows nothing: its notices go to its events alone (see ui.ts). */
const quietUI: AgentUI = { toolCall() {}, toolResult() {}, notice: ui.notice };

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

/** The project's AGENTS.md files, and a notice of each one left out. */
function followedInstructions(cwd: string): Instructions[] {
  const { instructions, warnings } = loadInstructions(cwd);
  for (const warning of warnings) ui.notice(warning);
  return instructions;
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
    loop: `Stopped: the model made the same tool calls, and got the same results, ${SAME_STEPS} steps in a row.`,
    empty: "", // the loop has said so
    time_limit: "Stopped at the time limit (--time-limit).",
    unapproved: `Stopped: ${NO_APPROVER}. Rules in jig's settings can allow them too.`,
  };
  const note = notes[result.stop] ?? `Stopped (${result.stop}).`;
  // The model's wrap-up at the step limit wasn't streamed (it is asked for like a summary), so it is printed here.
  if (result.stop === "max_steps" && result.text.trim()) ui.println(result.text.trim());
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

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return "Authentication failed: check DEEPSEEK_API_KEY (DeepSeek models), ANTHROPIC_API_KEY (Claude models) or OPENAI_API_KEY (others).";
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) return `API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
