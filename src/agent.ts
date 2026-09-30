import type Anthropic from "@anthropic-ai/sdk";
import type { CallModel } from "./model.ts";
import { checkInput, truncate, type Tool, type ToolInput } from "./tools/index.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Message = Anthropic.Beta.BetaMessage;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** What the loop reports as it goes. The CLI prints it; tests record it. */
export interface AgentUI {
  toolCall(name: string, description: string): void;
  toolResult(output: string, isError: boolean): void;
}

export interface AgentOptions {
  callModel: CallModel;
  tools: Tool[];
  cwd: string;
  /** Hard stop: the most model calls one task may take. */
  maxSteps: number;
  /** Guardrail, asked before every tool call that is not read-only. */
  approve(tool: Tool, input: ToolInput): Promise<boolean>;
  ui: AgentUI;
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
 * `messages` is the conversation so far, ending with the user's new message. The loop only ever appends
 * to it. Rewriting earlier messages would throw away the prompt cache and invalidate the model's
 * earlier thinking blocks.
 */
export async function runAgent(messages: MessageParam[], opts: AgentOptions, signal?: AbortSignal): Promise<RunResult> {
  const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const result = (stop: RunResult["stop"], steps: number, text = ""): RunResult => ({ stop, text, steps, usage });

  for (let step = 1; step <= opts.maxSteps; step++) {
    let reply: Message;
    let malformed: Map<string, string>;
    try {
      ({ message: reply, malformed } = await opts.callModel(messages, signal));
    } catch (err) {
      if (signal?.aborted) return result("interrupted", step - 1);
      throw err;
    }
    addUsage(usage, reply.usage);

    // A safety classifier declined, even after the fallback model. Whatever was streamed before the
    // decline is not a real answer, so it stays out of the history.
    if (reply.stop_reason === "refusal") return result("refusal", step);

    messages.push({ role: "assistant", content: reply.content });
    const calls = reply.content.filter((block): block is ToolUse => block.type === "tool_use");
    // A reply with no tool calls is the final answer.
    if (calls.length === 0) return result(reply.stop_reason ?? "end_turn", step, replyText(reply));

    // Every tool call gets a result, even ones that never run, or the next request is invalid.
    const cutOff = reply.stop_reason !== "tool_use"; // e.g. max_tokens: the last call's input may be incomplete
    const results: ToolResult[] = [];
    for (const call of calls) {
      results.push(await handleToolCall(call, { cutOff, malformed: malformed.get(call.id) }, opts, signal));
    }
    messages.push({ role: "user", content: results }); // all results for one reply go in one message

    if (signal?.aborted) return result("interrupted", step);
  }
  return result("max_steps", opts.maxSteps);
}

async function handleToolCall(
  call: ToolUse,
  state: { cutOff: boolean; malformed?: string },
  opts: AgentOptions,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const fail = (content: string): ToolResult => {
    opts.ui.toolResult(content, true);
    return { type: "tool_result", tool_use_id: call.id, content, is_error: true };
  };

  const tool = opts.tools.find((t) => t.definition.name === call.name);
  if (!tool) {
    opts.ui.toolCall(call.name, "");
    return fail(`Unknown tool "${call.name}". Available: ${opts.tools.map((t) => t.definition.name).join(", ")}.`);
  }
  if (signal?.aborted) {
    opts.ui.toolCall(call.name, "");
    return fail("Not run: the user interrupted.");
  }
  if (state.cutOff) {
    opts.ui.toolCall(call.name, "");
    return fail("Not run: your reply hit the output limit before this call was complete. Try again in smaller steps.");
  }
  // The model's input was streamed without server-side validation, so check it before anything runs.
  const problem = state.malformed !== undefined ? "input is not valid JSON" : checkInput(tool, call.input);
  if (problem) {
    opts.ui.toolCall(call.name, "(invalid input)");
    return fail(JSON.stringify({ INVALID_JSON: state.malformed ?? JSON.stringify(call.input), error: problem }));
  }

  const input = call.input as ToolInput;
  opts.ui.toolCall(call.name, tool.describe(input));
  if (!tool.readOnly && !(await opts.approve(tool, input))) {
    return fail("The user declined this tool call. Ask them how they want to proceed.");
  }
  try {
    const output = truncate(await tool.run(input, { cwd: opts.cwd, signal }));
    opts.ui.toolResult(output, false);
    return { type: "tool_result", tool_use_id: call.id, content: output };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function replyText(reply: Message): string {
  return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function addUsage(total: Usage, usage: Anthropic.Beta.BetaUsage): void {
  total.input += usage.input_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.output += usage.output_tokens;
}
