import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { Tool } from "./tools/index.ts";
import * as ui from "./ui.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelTurn {
  message: Anthropic.Beta.BetaMessage;
  /** Raw input of each tool call whose streamed JSON did not parse, keyed by tool_use id. */
  malformed: Map<string, string>;
}

/** One model call: the conversation in, the model's next message out, streamed to the terminal on the way. */
export type CallModel = (messages: MessageParam[], signal?: AbortSignal) => Promise<ModelTurn>;

export interface ModelOptions {
  model: string;
  /** Left out, the model's own default is used. */
  effort?: Effort;
  system: string;
  tools: Tool[];
}

/** Everything in a request except `messages`. It stays the same for the whole session. */
type Request = Omit<BetaMessageStreamParams, "messages">;

// DeepSeek serves an Anthropic-compatible API, so the same SDK, streaming and message format work with it.
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";

export function createModel(options: ModelOptions): CallModel {
  const deepseek = options.model.startsWith("deepseek");
  const client = deepseek ? deepseekClient() : new Anthropic(); // Anthropic() reads ANTHROPIC_API_KEY
  const request = deepseek ? deepseekRequest(options) : claudeRequest(options);

  return async (messages, signal) => {
    const sent = deepseek ? withoutIsError(messages) : messages;
    for (let attempt = 1; ; attempt++) {
      try {
        return await streamTurn(client, { ...request, messages: sent }, signal);
      } catch (err) {
        // API errors are not retried here: the SDK already retries rate limits and overloads.
        if (!(err instanceof MalformedToolInput) || attempt === 3) throw err;
        ui.notice("The model sent malformed tool input; asking again.");
      }
    }
  };
}

function claudeRequest({ model, effort = "medium", system, tools }: ModelOptions): Request {
  return {
    model,
    max_tokens: 64_000, // counts thinking too; long coding turns need the room
    betas: ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"],
    // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
    fallbacks: "default",
    // Thinking is always on for this model and effort sets how much. "updates" returns the short progress
    // notes the model writes between tool calls, while the reasoning itself stays hidden.
    thinking: { type: "adaptive", display: "updates" },
    output_config: { effort },
    // The prompt is cached as a prefix in the order tools, system, messages, and each call repeats the
    // previous one plus a few new messages. So: one breakpoint after the fixed system prompt, plus automatic
    // caching (top-level cache_control) that moves with the end of the conversation.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    cache_control: { type: "ephemeral" },
    // Stream tool input as it is generated instead of in one burst at the end. The API then stops
    // validating it, so streamTurn() and the agent loop check it before any tool runs.
    tools: tools.map((tool) => ({ ...tool.definition, eager_input_streaming: true })),
  };
}

function deepseekClient(): Anthropic {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY to use DeepSeek models.");
  // Without authToken: null, the SDK would also send ANTHROPIC_AUTH_TOKEN from the environment to DeepSeek.
  return new Anthropic({ baseURL: DEEPSEEK_BASE_URL, apiKey, authToken: null });
}

/**
 * DeepSeek thinks by default (effort "high"; it accepts low, high and max) and streams its reasoning as
 * thinking blocks, which go back in the history like Claude's. The Claude-only settings above (beta
 * features, fallbacks, cache breakpoints, eager tool streaming) are left out; DeepSeek caches on its own.
 */
function deepseekRequest({ model, effort, system, tools }: ModelOptions): Request {
  return {
    model,
    max_tokens: 64_000,
    ...(effort && { output_config: { effort } }),
    system,
    tools: tools.map((tool) => tool.definition),
  };
}

/** DeepSeek does not support is_error on tool results, so failures are marked in the text instead. */
function withoutIsError(messages: MessageParam[]): MessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const { is_error, ...result } = block;
      return is_error && typeof result.content === "string" ? { ...result, content: `Error: ${result.content}` } : result;
    });
    return { ...message, content };
  });
}

/** A tool input so broken the SDK could not parse it at all, which fails the whole stream. */
class MalformedToolInput extends Error {}

async function streamTurn(client: Anthropic, params: BetaMessageStreamParams, signal?: AbortSignal): Promise<ModelTurn> {
  const stream = client.beta.messages.stream(params, { signal });
  const rawInputs = new Map<number, string>(); // content block index -> tool input JSON as streamed
  let message: Anthropic.Beta.BetaMessage;

  ui.status("thinking…");
  try {
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") ui.status(`${block.name}…`);
        if (block.type === "fallback") ui.notice(`${block.from.model} declined; ${block.to.model} is continuing.`);
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") ui.text(delta.text);
        else if (delta.type === "thinking_delta") ui.progress(delta.thinking); // reasoning is empty; notes are not
        else if (delta.type === "input_json_delta") {
          rawInputs.set(event.index, (rawInputs.get(event.index) ?? "") + delta.partial_json);
        }
      } else if (event.type === "content_block_stop") {
        ui.endBlock();
      }
    }
    message = await stream.finalMessage();
  } catch (err) {
    // The reply never finished, so there is no tool call to answer with an error: the caller asks again.
    const brokenJson = [...rawInputs.values()].some((raw) => !isJson(raw));
    if (brokenJson && !(err instanceof Anthropic.APIError)) {
      throw new MalformedToolInput("The model sent tool input that is not valid JSON.", { cause: err });
    }
    throw err;
  }

  // The SDK parses streamed tool input leniently: JSON with, say, an unescaped quote can come back as a
  // valid-looking object whose string was cut short. A strict parse keeps a mangled write off the disk.
  const malformed = new Map<string, string>();
  message.content.forEach((block, index) => {
    const raw = rawInputs.get(index);
    if (block.type === "tool_use" && raw !== undefined && !isJson(raw)) malformed.set(block.id, raw);
  });
  return { message: { ...message, content: dropDeclined(message.content) }, malformed };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text || "{}"); // a tool without parameters streams no input at all
    return true;
  } catch {
    return false;
  }
}

/**
 * After a fallback in mid-reply, everything before the last `fallback` marker came from the model that
 * declined. Its text stays (the user saw it, and the fallback model continued from it), but its thinking
 * and tool calls must not be sent back or run.
 */
function dropDeclined(content: ContentBlock[]): ContentBlock[] {
  const cut = content.findLastIndex((block) => block.type === "fallback");
  if (cut === -1) return content;
  return [...content.slice(0, cut).filter((block) => block.type === "text"), ...content.slice(cut + 1)];
}
