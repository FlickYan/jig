import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { ReasoningEffort } from "openai/resources/shared";
import type { ModelTurn } from "./model.ts";
import type { Tool } from "./tools/index.ts";
import * as ui from "./ui.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

// An OpenAI-compatible chat completions API (DeepSeek's, OpenAI's, or a local server such as Ollama or vLLM).
// jig keeps its conversation in the Messages API's format, content blocks and all, so the rest of jig is the
// same whichever API it talks to: requests are translated here on the way out, and replies on the way in.

export interface ChatOptions {
  model: string;
  system: string;
  tools: Tool[];
  effort?: string;
  /** Most output tokens per reply (thinking included). Left out, the server's default. */
  maxTokens?: number;
}

/** A reply that ended before it was finished: the stream stopped without saying why it was done. */
export class ReplyBrokeOff extends Error {}

/**
 * The conversation as chat messages. Thinking goes back as `reasoning_content`, which DeepSeek requires on
 * every earlier reply once tools are in play (without it the request fails), and each tool result becomes
 * a "tool" message, which must come straight after the reply that made the call.
 */
export function toChatMessages(system: string, messages: MessageParam[]): ChatCompletionMessageParam[] {
  const chat: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (typeof message.content === "string") {
      chat.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content;
    const text = (separator: string) => blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(separator);
    if (message.role === "assistant") {
      const reasoning = blocks.flatMap((block) => (block.type === "thinking" ? [block.thinking] : [])).join("");
      const calls: ChatCompletionMessageFunctionToolCall[] = blocks.flatMap((block) =>
        block.type === "tool_use" ? [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } }] : [],
      );
      // reasoning_content isn't in the OpenAI types: it is DeepSeek's (and vLLM's) field.
      chat.push({ role: "assistant", content: text("") || null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) });
      continue;
    }
    for (const block of blocks) {
      if (block.type === "tool_result") chat.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block) });
    }
    if (text("\n\n")) chat.push({ role: "user", content: text("\n\n") });
  }
  return chat;
}

/** The chat API has no is_error, so a failed call says so in its text. */
function toolResultText(block: Anthropic.Beta.BetaToolResultBlockParam): string {
  const content = block.content ?? "";
  const text = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
  return block.is_error ? `Error: ${text}` : text;
}

/** jig's tool definitions as chat completions functions: the same names, descriptions and schemas. */
export function toChatTools(tools: Tool[]): ChatCompletionFunctionTool[] {
  return tools.map(({ definition }) => ({
    type: "function",
    function: { name: definition.name, description: definition.description ?? "", parameters: definition.input_schema as Record<string, unknown> },
  }));
}

/**
 * One model call through a chat completions API, streamed to the terminal like a Messages API reply and
 * returned as one: reasoning as a thinking block, then the text, then the tool calls.
 */
export async function chatTurn(
  client: OpenAI,
  options: ChatOptions,
  messages: MessageParam[],
  { signal, quiet = false, summarize = false }: { signal?: AbortSignal; quiet?: boolean; summarize?: boolean },
): Promise<ModelTurn> {
  const tools = toChatTools(options.tools);
  if (!quiet) ui.status("thinking…");
  const stream = await client.chat.completions.create(
    {
      model: options.model,
      messages: toChatMessages(options.system, messages),
      // Tools stay declared when summarizing (the history refers to them); "none" stops new calls.
      ...(tools.length ? { tools, ...(summarize ? { tool_choice: "none" as const } : {}) } : {}),
      // DeepSeek takes low, high and max; OpenAI's models their own levels. Left out, the model's default.
      ...(options.effort ? { reasoning_effort: options.effort as ReasoningEffort } : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal },
  );

  let id = "";
  let model = "";
  let reasoning = "";
  let text = "";
  let finish: string | null = null;
  let usage: ChatCompletionChunk["usage"] = null;
  const calls: { id: string; name: string; arguments: string }[] = [];
  // The stream has no block boundaries, so a block ends where the next kind of output starts.
  let showing: "thinking" | "text" | "tool" | undefined;
  const show = (kind: "thinking" | "text" | "tool") => {
    if (showing && showing !== kind) ui.endBlock();
    showing = kind;
  };
  for await (const chunk of stream) {
    id ||= chunk.id;
    model ||= chunk.model;
    usage = chunk.usage ?? usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta as ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null; reasoning?: string | null };
    const thought = delta.reasoning_content ?? delta.reasoning; // DeepSeek and vLLM call it one, some servers the other
    if (thought) {
      reasoning += thought;
      if (!quiet) {
        show("thinking");
        ui.thinking(thought);
      }
    }
    if (delta.content) {
      text += delta.content;
      if (!quiet) {
        show("text");
        ui.text(delta.content);
      }
    }
    for (const part of delta.tool_calls ?? []) {
      const call = (calls[part.index] ??= { id: "", name: "", arguments: "" });
      if (part.id) call.id = part.id;
      if (part.function?.name) {
        call.name += part.function.name;
        if (!quiet) {
          show("tool");
          ui.status(`${call.name}…`);
        }
      }
      call.arguments += part.function?.arguments ?? "";
    }
    finish = choice.finish_reason ?? finish;
  }
  if (!quiet && showing) ui.endBlock();
  if (!finish) throw new ReplyBrokeOff(id ? "the stream ended before the reply was finished" : "the API sent no reply");

  const content: ContentBlock[] = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (text) content.push({ type: "text", text, citations: null });
  const malformed = new Map<string, string>();
  calls.forEach((call, index) => {
    const callId = call.id || `call_${index}`; // some local servers leave the id out
    const input = parseJson(call.arguments);
    if (input === undefined) malformed.set(callId, call.arguments);
    content.push({ type: "tool_use", id: callId, name: call.name, input: input ?? {} } as ContentBlock);
  });

  // The chat API counts cached tokens inside prompt_tokens; the Messages API counts them apart.
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? (usage as { prompt_cache_hit_tokens?: number } | null)?.prompt_cache_hit_tokens ?? 0;
  const stop = finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : calls.length ? "tool_use" : "end_turn";
  const message = {
    id: id || "chat",
    type: "message",
    role: "assistant",
    model: model || options.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: (usage?.prompt_tokens ?? 0) - cached,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  } as unknown as Anthropic.Beta.BetaMessage; // the fields jig reads; the rest of the type is Claude's
  return { message, malformed, offered: tools.map((tool) => tool.function.name) };
}

/** The parsed tool input, or undefined if it isn't a JSON object. A tool without parameters may send none. */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text || "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
