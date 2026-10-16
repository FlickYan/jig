// The agent loop (runAgent), and what happens around one tool call: checking the model's input, the
// user's hooks, the permission policy, running the tool and trimming its output. The CLI and subagents
// drive the same loop; what differs between them comes in through AgentOptions.

import type Anthropic from "@anthropic-ai/sdk";
import { compact } from "./compact.ts";
import type { Conversation } from "./conversation.ts";
import type { CallModel } from "./model.ts";
import type { Sandbox } from "./sandbox.ts";
import { checkInput, truncate, type Tool, type ToolInput } from "./tools/index.ts";

type Message = Anthropic.Beta.BetaMessage;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** What the loop reports as it goes. The CLI prints it; tests record it. */
export interface AgentUI {
  /** `id` tells calls apart: calls that only read run at the same time, so results can come in any order. */
  toolCall(name: string, description: string, id: string): void;
  toolResult(output: string, isError: boolean, id: string): void;
  notice(text: string): void;
}

/** How a run of the loop is set up: the model, the tools, and the checks every tool call goes through. */
export interface AgentOptions {
  callModel: CallModel;
  tools: Tool[];
  cwd: string;
  /** Hard stop: the most model calls one task may take. */
  maxSteps: number;
  /** Compact the conversation before a model call once it is larger than this many tokens (0: never). */
  compactAt: number;
  /** Guardrail, asked before every tool call: resolves to the reason it may not run, or null if it may. */
  authorize(tool: Tool, input: ToolInput): Promise<string | null>;
  /** Where commands run, if not directly on the machine. */
  sandbox?: Sandbox;
  /** Directories outside the project the file tools may use too (--add-dir). */
  dirs?: string[];
  /** Paths the settings hide (hiddenPaths), which the file tools refuse too. */
  hidden?: string[];
  /** The user's hooks around tool calls (see hooks.ts). */
  hooks?: ToolHooks;
  /**
   * Sent once, the first time the model stops, so it checks its work before the task ends. For one-shot
   * runs, where nobody is there to look at the result and ask for more.
   */
  review?: string;
  /** A stronger model that takes over the steps left once a test command the model ran fails (--escalate). */
  escalate?: { model: string; callModel: CallModel };
  /** A second model that checks the work against the task the first time the model stops (--reviewer). */
  reviewer?: Reviewer;
  ui: AgentUI;
}

/** A model that reviews the work before the task ends (see review.ts). */
export interface Reviewer {
  model: string;
  /**
   * Resolves to its verdict, what the model is told about the problems it found (if it found any), and the
   * tokens it took. It is given the task, the model's last message, and this run's messages from the task on.
   */
  review(work: { task: string; answer: string; messages: Anthropic.Beta.BetaMessageParam[] }, signal?: AbortSignal): Promise<{ verdict: ReviewVerdict; feedback?: string; text?: string; usage: Usage }>;
}

/** Approved, problems found (and sent back), or no verdict (out of steps, say): then the work stands. */
export type ReviewVerdict = "approved" | "problems" | "none";

/** The user's hooks, as the loop sees them (the CLI builds them from the settings). */
export interface ToolHooks {
  /** Before a call runs: resolves to why it is blocked, or null. */
  before(tool: string, input: ToolInput): Promise<string | null>;
  /** After a call ran: resolves to feedback for the model about the result, or null. */
  after(tool: string, input: ToolInput, output: string): Promise<string | null>;
}

/** Tokens, summed over a run's model calls. */
export interface Usage {
  input: number; // uncached input tokens
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** How a run ended. */
export interface RunResult {
  /** Why the loop ended: the last reply's stop_reason (end_turn, max_tokens, refusal, ...), or one of ours. */
  stop: Anthropic.Beta.BetaStopReason | "max_steps" | "interrupted";
  /** Text of the final reply. */
  text: string;
  steps: number;
  /** Every model call's tokens, the escalation's included. */
  usage: Usage;
  /** Which model took over, at which step, and the tokens of its calls. */
  escalated?: { model: string; step: number; usage: Usage };
  /** The review: by which model, after which step, its verdict, and its tokens. */
  reviewed?: { model: string; step: number; verdict: ReviewVerdict; usage: Usage };
}

/**
 * The agent loop: call the model, run the tools it asks for, send back the results, and repeat until
 * it replies without asking for a tool.
 *
 * The conversation ends with the user's new message. The loop only ever appends to it, apart from
 * compaction, which replaces it whole: rewriting earlier messages would throw away the prompt cache and
 * invalidate the model's earlier thinking blocks.
 */
export async function runAgent(conversation: Conversation, opts: AgentOptions, signal?: AbortSignal): Promise<RunResult> {
  const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let escalated: RunResult["escalated"];
  let review: RunResult["reviewed"];
  const result = (stop: RunResult["stop"], steps: number, text = ""): RunResult => ({ stop, text, steps, usage, ...(escalated && { escalated }), ...(review && { reviewed: review }) });
  // Whether the work was checked (by --check's request or a reviewer): it is, at most once a run.
  let reviewed = false;
  // The task is the message the run starts from; a reviewer sees it and what the run did after it (all
  // there is, if a compaction has replaced it with a summary).
  const taskMessage = conversation.messages.at(-1);
  const task = textOf(taskMessage);
  const sinceTask = () => conversation.messages.slice(Math.max(0, conversation.messages.indexOf(taskMessage!)));

  for (let step = 1; step <= opts.maxSteps; step++) {
    let reply: Message;
    let malformed: Map<string, string>;
    let offered: string[] | undefined;
    try {
      if (opts.compactAt > 0 && conversation.tokens > opts.compactAt) {
        addUsage(usage, await compactConversation(conversation, opts, signal));
      }
      const callModel = escalated ? opts.escalate!.callModel : opts.callModel;
      ({ message: reply, malformed, offered } = await callModel(conversation.messages, signal));
    } catch (err) {
      if (signal?.aborted) return result("interrupted", step - 1);
      throw err;
    }
    addUsage(usage, reply.usage);
    if (escalated) addUsage(escalated.usage, reply.usage);

    // A safety classifier declined, even after the fallback model. Whatever was streamed before the
    // decline is not a real answer, so it stays out of the history.
    if (reply.stop_reason === "refusal") return result("refusal", step);

    conversation.push({ role: "assistant", content: reply.content });
    conversation.tokens = contextSize(reply.usage); // measured: the whole request plus this reply
    const calls = reply.content.filter((block): block is ToolUse => block.type === "tool_use");
    // A reply with no tool calls is the final answer, unless the work is still to be checked.
    if (calls.length === 0) {
      // By a second model, once, while there are steps left to act on what it finds.
      if (opts.reviewer && !reviewed && reply.stop_reason === "end_turn" && step < opts.maxSteps) {
        reviewed = true;
        const { model } = opts.reviewer;
        opts.ui.notice(`${model} is reviewing the work.`);
        try {
          const found = await opts.reviewer.review({ task, answer: replyText(reply), messages: sinceTask() }, signal);
          addUsages(usage, found.usage);
          if (signal?.aborted) return result("interrupted", step);
          review = { model, step, verdict: found.verdict, usage: found.usage };
          if (found.feedback) {
            opts.ui.notice(`${model} found problems; the model takes them up.`);
            conversation.push({ role: "user", content: found.feedback });
            continue;
          }
          const said = found.text?.trim() ? ` (it said: "${found.text.trim().replace(/\s+/g, " ").slice(0, 160)}…")` : "";
          opts.ui.notice(found.verdict === "approved" ? `${model} found no problems.` : `${model} gave no verdict${said}, so the work stands as it is.`);
        } catch (err) {
          if (signal?.aborted) return result("interrupted", step);
          // A review that failed leaves the work as it is: it was only a check.
          opts.ui.notice(`The review failed (${err instanceof Error ? err.message : String(err)}), so the work stands as it is.`);
        }
      } else if (opts.review && !reviewed && reply.stop_reason === "end_turn") {
        reviewed = true;
        opts.ui.notice("Checking the work before finishing.");
        conversation.push({ role: "user", content: opts.review });
        continue;
      }
      return result(reply.stop_reason ?? "end_turn", step, replyText(reply));
    }

    // Every tool call gets a result, even ones that never run, or the next request is invalid.
    const cutOff = reply.stop_reason !== "tool_use"; // e.g. max_tokens: the last call's input may be incomplete
    const handle = (call: ToolUse) => handleToolCall(call, { cutOff, malformed: malformed.get(call.id), offered }, conversation, opts, usage, signal);
    // Calls that only read (searches, file reads, subagents) can't interfere with each other, so they
    // run at the same time. Anything else runs in order, since one call may depend on another's effect.
    const readOnly = calls.every((call) => opts.tools.find((t) => t.definition.name === call.name)?.kind === "read");
    const results: ToolResult[] = [];
    if (readOnly) results.push(...(await Promise.all(calls.map(handle))));
    else for (const call of calls) results.push(await handle(call));
    conversation.push({ role: "user", content: results }); // all results for one reply go in one message

    // A failed test run is the model's own check saying the work isn't right yet: the stronger model takes
    // the steps left, with the whole conversation, so it starts where the first one stopped.
    if (opts.escalate && !escalated && step < opts.maxSteps && calls.some((call, i) => failedTestRun(call, results[i]))) {
      escalated = { model: opts.escalate.model, step: step + 1, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
      opts.ui.notice(`A test run failed: ${opts.escalate.model} takes over from step ${step + 1}.`);
    }

    if (signal?.aborted) return result("interrupted", step);
  }
  return result("max_steps", opts.maxSteps);
}

/**
 * Compacts between steps. A new request from the user is kept out of the summary and stays after it,
 * so the model still gets the user's exact words; otherwise the task is mid-way and the model carries on.
 */
async function compactConversation(conversation: Conversation, opts: AgentOptions, signal?: AbortSignal) {
  const last = conversation.messages.at(-1);
  const isRequest = last?.role === "user" && typeof last.content === "string";
  opts.ui.notice(`Compacting the conversation (${formatTokens(conversation.tokens)} tokens)…`);
  const compacted = await compact(conversation, opts.callModel, { signal, keep: isRequest ? [last] : [], continueTask: !isRequest });
  if (!compacted) return { input_tokens: 0, output_tokens: 0 } as Anthropic.Beta.BetaUsage;
  opts.ui.notice(`Compacted ${formatTokens(compacted.before)} tokens into about ${formatTokens(compacted.after)}.`);
  return compacted.usage;
}

/**
 * One tool call, through each check in turn: the tool exists and the request offered it, the run wasn't
 * interrupted, the call wasn't cut off mid-input, the input is valid, the hooks and then the permission
 * policy allow it. Then it runs, its output is trimmed, and the after-hooks have their say. A failed check
 * becomes an error result that says what went wrong, which the model can act on.
 */
async function handleToolCall(
  call: ToolUse,
  state: { cutOff: boolean; malformed?: string; offered?: string[] },
  conversation: Conversation,
  opts: AgentOptions,
  usage: Usage,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const fail = (content: string): ToolResult => {
    opts.ui.toolResult(content, true, call.id);
    return { type: "tool_result", tool_use_id: call.id, content, is_error: true };
  };

  const tool = opts.tools.find((t) => t.definition.name === call.name);
  // A tool the request didn't declare isn't the model's to call, even one jig has.
  const offered = state.offered ?? opts.tools.map((t) => t.definition.name);
  if (!tool || !offered.includes(call.name)) {
    opts.ui.toolCall(call.name, "", call.id);
    return fail(`${tool ? `Not run: ${call.name} isn't one of the tools offered for this step` : `Unknown tool "${call.name}"`}. Available: ${offered.join(", ")}.`);
  }
  if (signal?.aborted) {
    opts.ui.toolCall(call.name, "", call.id);
    return fail("Not run: the user interrupted.");
  }
  if (state.cutOff) {
    opts.ui.toolCall(call.name, "", call.id);
    return fail("Not run: your reply hit the output limit before this call was complete. Try again in smaller steps.");
  }
  // The model's input was streamed without server-side validation, so check it before anything runs.
  const problem = state.malformed !== undefined ? jsonProblem(state.malformed) : checkInput(tool, call.input);
  if (problem) {
    opts.ui.toolCall(call.name, "(invalid input)", call.id);
    return fail(invalidInput(state.malformed ?? JSON.stringify(call.input), problem));
  }

  const input = call.input as ToolInput;
  opts.ui.toolCall(call.name, tool.describe(input), call.id);
  // Hooks first, as in Claude Code: no point asking the user about a call a hook would block anyway.
  const blocked = await opts.hooks?.before(call.name, input);
  if (blocked) return fail(`Blocked by a hook: ${blocked}`);
  const refusal = await opts.authorize(tool, input);
  if (refusal) return fail(refusal);
  let output: string;
  try {
    const pin = (key: string, text: string) => conversation.pin(key, text);
    const context = { cwd: opts.cwd, dirs: opts.dirs, hidden: opts.hidden, versions: conversation.versions, signal, sandbox: opts.sandbox, pin, usage };
    output = truncate(await tool.run(input, context));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const feedback = await opts.hooks?.after(call.name, input, output);
  if (feedback) output = `${output.trimEnd()}\n\nA hook checked this result and reported:\n${feedback}`;
  opts.ui.toolResult(output, false, call.id);
  return { type: "tool_result", tool_use_id: call.id, content: output };
}

/** How much of an invalid call's input goes back to the model: its start, and what came just before the error. */
const SHOWN_START = 2_000;
const SHOWN_BEFORE_ERROR = 400;

/**
 * An invalid call, as the model is told of it: what was wrong, and enough of what it wrote to see why. Not
 * all of it: a reply that runs until its output limit can leave a call of 100k characters, and in milestone
 * 27, sent back whole, such calls made a 32k server's conversations outgrow it.
 */
function invalidInput(raw: string, error: string): string {
  if (raw.length <= SHOWN_START) return JSON.stringify({ INVALID_JSON: raw, error });
  const at = Number(/in JSON at position (\d+)/.exec(error)?.[1] ?? 0);
  const before = at > SHOWN_START ? raw.slice(Math.max(SHOWN_START, at - SHOWN_BEFORE_ERROR), at) : "";
  const shown = `its first ${SHOWN_START} characters${before ? `, and the ${before.length} before the error` : ""}, of ${raw.length}`;
  return JSON.stringify({ INVALID_JSON: `${raw.slice(0, SHOWN_START)}…`, ...(before && { BEFORE_ERROR: `…${before}` }), error, shown });
}

/** Why streamed input isn't a tool's input, in the parser's words (they give the position). */
function jsonProblem(raw: string): string {
  try {
    JSON.parse(raw || "{}");
  } catch (err) {
    return `input is not valid JSON (${(err instanceof Error ? err.message : String(err)).slice(0, 200)})`;
  }
  return "input is not a JSON object";
}

/** Commands that run a project's tests, by the usual runners' names. */
const TEST_COMMAND = /\b(pytest|unittest|tox|npm (run )?test|yarn test|pnpm test|node --test|jest|vitest|mocha|go test|cargo test|make (check|test)|rspec|phpunit|dotnet test|ctest)\b/;

/** What the runners print when tests fail: unittest, pytest, node --test, jest and vitest, go test, cargo test. */
const TESTS_FAILED = /^FAILED \(|\b[1-9]\d* (failed|errors?)\b|^(#|ℹ) fail [1-9]|^--- FAIL|^FAIL\b|test result: FAILED/m;

/**
 * Whether a call ran the tests and they failed: a non-zero exit code, or the runner's own report, since
 * a pipe like `| tail -20`, which models add to most test runs, leaves the exit code tail's.
 */
export function failedTestRun(call: ToolUse, result: ToolResult): boolean {
  if (call.name !== "bash" || !TEST_COMMAND.test(String((call.input as ToolInput).command ?? ""))) return false;
  const content = typeof result.content === "string" ? result.content : "";
  return /Exit code: [1-9]\d*\s*$/.test(content) || TESTS_FAILED.test(content);
}

/** The text of a message: a string, or its text blocks joined. */
function textOf(message?: Anthropic.Beta.BetaMessageParam): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function replyText(reply: Message): string {
  return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Adds one run's token counts to another's (a review's to its task's). */
export function addUsages(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.cacheWrite += usage.cacheWrite;
  total.cacheRead += usage.cacheRead;
  total.output += usage.output;
}

/** Adds one reply's token counts to a run's totals. */
export function addUsage(total: Usage, usage: Anthropic.Beta.BetaUsage): void {
  total.input += usage.input_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.output += usage.output_tokens;
}

/** Tokens in a request (cached or not) plus its reply: the size of the conversation after that step. */
export function contextSize(usage: Anthropic.Beta.BetaUsage): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens;
}

/** 950 → "950", 12_345 → "12.3k". */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
