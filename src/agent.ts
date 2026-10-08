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
  /** The user's hooks around tool calls (see hooks.ts). */
  hooks?: ToolHooks;
  /**
   * Sent once, the first time the model stops, so it checks its work before the task ends. For one-shot
   * runs, where nobody is there to look at the result and ask for more.
   */
  review?: string;
  ui: AgentUI;
}

export interface ToolHooks {
  /** Before a call runs: resolves to why it is blocked, or null. */
  before(tool: string, input: ToolInput): Promise<string | null>;
  /** After a call ran: resolves to feedback for the model about the result, or null. */
  after(tool: string, input: ToolInput, output: string): Promise<string | null>;
}

export interface Usage {
  input: number; // uncached input tokens
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface RunResult {
  /** Why the loop ended: the last reply's stop_reason (end_turn, max_tokens, refusal, ...), or one of ours. */
  stop: Anthropic.Beta.BetaStopReason | "max_steps" | "interrupted";
  /** Text of the final reply. */
  text: string;
  steps: number;
  usage: Usage;
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
  const result = (stop: RunResult["stop"], steps: number, text = ""): RunResult => ({ stop, text, steps, usage });
  let reviewed = false;

  for (let step = 1; step <= opts.maxSteps; step++) {
    let reply: Message;
    let malformed: Map<string, string>;
    try {
      if (opts.compactAt > 0 && conversation.tokens > opts.compactAt) {
        addUsage(usage, await compactConversation(conversation, opts, signal));
      }
      ({ message: reply, malformed } = await opts.callModel(conversation.messages, signal));
    } catch (err) {
      if (signal?.aborted) return result("interrupted", step - 1);
      throw err;
    }
    addUsage(usage, reply.usage);

    // A safety classifier declined, even after the fallback model. Whatever was streamed before the
    // decline is not a real answer, so it stays out of the history.
    if (reply.stop_reason === "refusal") return result("refusal", step);

    conversation.push({ role: "assistant", content: reply.content });
    conversation.tokens = contextSize(reply.usage); // measured: the whole request plus this reply
    const calls = reply.content.filter((block): block is ToolUse => block.type === "tool_use");
    // A reply with no tool calls is the final answer, unless the work is still to be checked.
    if (calls.length === 0) {
      if (opts.review && !reviewed && reply.stop_reason === "end_turn") {
        reviewed = true;
        opts.ui.notice("Checking the work before finishing.");
        conversation.push({ role: "user", content: opts.review });
        continue;
      }
      return result(reply.stop_reason ?? "end_turn", step, replyText(reply));
    }

    // Every tool call gets a result, even ones that never run, or the next request is invalid.
    const cutOff = reply.stop_reason !== "tool_use"; // e.g. max_tokens: the last call's input may be incomplete
    const handle = (call: ToolUse) => handleToolCall(call, { cutOff, malformed: malformed.get(call.id) }, conversation, opts, usage, signal);
    // Calls that only read (searches, file reads, subagents) can't interfere with each other, so they
    // run at the same time. Anything else runs in order, since one call may depend on another's effect.
    const readOnly = calls.every((call) => opts.tools.find((t) => t.definition.name === call.name)?.kind === "read");
    const results: ToolResult[] = [];
    if (readOnly) results.push(...(await Promise.all(calls.map(handle))));
    else for (const call of calls) results.push(await handle(call));
    conversation.push({ role: "user", content: results }); // all results for one reply go in one message

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

async function handleToolCall(
  call: ToolUse,
  state: { cutOff: boolean; malformed?: string },
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
  if (!tool) {
    opts.ui.toolCall(call.name, "", call.id);
    return fail(`Unknown tool "${call.name}". Available: ${opts.tools.map((t) => t.definition.name).join(", ")}.`);
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
  const problem = state.malformed !== undefined ? "input is not valid JSON" : checkInput(tool, call.input);
  if (problem) {
    opts.ui.toolCall(call.name, "(invalid input)", call.id);
    return fail(JSON.stringify({ INVALID_JSON: state.malformed ?? JSON.stringify(call.input), error: problem }));
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
    const context = { cwd: opts.cwd, dirs: opts.dirs, versions: conversation.versions, signal, sandbox: opts.sandbox, pin, usage };
    output = truncate(await tool.run(input, context));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const feedback = await opts.hooks?.after(call.name, input, output);
  if (feedback) output = `${output.trimEnd()}\n\nA hook checked this result and reported:\n${feedback}`;
  opts.ui.toolResult(output, false, call.id);
  return { type: "tool_result", tool_use_id: call.id, content: output };
}

function replyText(reply: Message): string {
  return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

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

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
