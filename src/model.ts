import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import OpenAI from "openai";
import { chatTurn, ReplyBrokeOff } from "./openai.ts";
import type { Tool } from "./tools/index.ts";
import * as ui from "./ui.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The API formats jig speaks: Anthropic's Messages API, and OpenAI-compatible chat completions. */
export const APIS = ["anthropic", "openai"] as const;
export type Api = (typeof APIS)[number];

/**
 * Claude and DeepSeek models go through the Messages API (DeepSeek's Anthropic-compatible endpoint), any
 * other model through an OpenAI-compatible one. DeepSeek serves both, so --api openai reaches it there too.
 */
export function defaultApi(model: string): Api {
  return model.startsWith("claude") || model.startsWith("deepseek") ? "anthropic" : "openai";
}

export interface ModelTurn {
  message: Anthropic.Beta.BetaMessage;
  /** Raw input of each tool call whose streamed JSON did not parse, keyed by tool_use id. */
  malformed: Map<string, string>;
}

/**
 * One model call: the conversation in, the model's next message out, streamed to the terminal on the way.
 * With `summarize`, the model may not call tools and nothing is printed (used for compaction).
 */
export type CallModel = (messages: MessageParam[], signal?: AbortSignal, options?: { summarize?: boolean }) => Promise<ModelTurn>;

export interface ModelOptions {
  model: string;
  /** Print nothing while streaming (for subagents, whose work the user sees as a summary). */
  quiet?: boolean;
  /** Milliseconds to wait for the API to start answering (default: 2 minutes); for tests. */
  timeout?: number;
  /** Left out, the model's own default is used. */
  effort?: Effort;
  system: string;
  tools: Tool[];
  /** The API format (default: defaultApi). */
  api?: Api;
  /** The API's address, instead of the provider's own. */
  baseURL?: string;
}

/**
 * How many tokens a model can take in. All current DeepSeek and Claude models have 1M, except Haiku; for
 * anything else, 128k is a common size (a smaller window needs --compact-at to match).
 */
export function contextWindow(model: string): number {
  if (model.startsWith("claude-haiku")) return 200_000;
  return model.startsWith("claude") || model.startsWith("deepseek") ? 1_000_000 : 128_000;
}

/** Everything in a request except `messages`. It stays the same for the whole session. */
type Request = Omit<BetaMessageStreamParams, "messages">;

// DeepSeek serves an Anthropic-compatible API, so the same SDK, streaming and message format work with it,
// and an OpenAI-compatible one.
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";

/**
 * How long to wait for the API to start answering. A stream's headers arrive within seconds when the
 * API is healthy, however long the reply, and the SDK's timeout covers only that wait. Its default is
 * 10 minutes, so a hung API (as DeepSeek was during the Terminal-Bench runs) cost 30 silent minutes with
 * the two retries; now it fails within about 6, saying so as it goes.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The SDK retries rate limits, overloads, server errors and timeouts on its own, with backoff. It
 * reports each retry in its log; this turns those lines into notices, so a struggling API doesn't
 * look like a frozen agent.
 */
export const retryNotices = {
  info(message: string) {
    const retry = /(timed out|failed with status (\d+)|failed).* - retrying, (\d+) attempts? remaining/.exec(message);
    if (!retry) return;
    const what = retry[1] === "timed out" ? "didn't answer in time" : retry[2] ? `answered with status ${retry[2]}` : "couldn't be reached";
    ui.notice(`The API ${what}; trying again (${retry[3]} ${retry[3] === "1" ? "try" : "tries"} left).`);
  },
  debug() {},
  warn() {},
  error() {},
};

type Turn = (messages: MessageParam[], signal: AbortSignal | undefined, summarize: boolean) => Promise<ModelTurn>;

export function createModel(options: ModelOptions): CallModel {
  const settings = { timeout: options.timeout ?? REQUEST_TIMEOUT_MS, logger: retryNotices, logLevel: "info" as const };
  const turn = (options.api ?? defaultApi(options.model)) === "openai" ? chatCompletions(options, settings) : messagesApi(options, settings);

  return async (messages, signal, { summarize = false } = {}) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await turn(messages, signal, summarize);
      } catch (err) {
        // API errors are mostly not retried here: the SDK already retries rate limits, overloads and
        // requests that fail before a reply begins. What it can't retry is a reply that broke off partway,
        // or one with malformed tool input.
        if (attempt === 3 || signal?.aborted) throw err;
        if (brokeOff(err)) {
          ui.notice(`The reply broke off before it was finished; trying again (${3 - attempt} ${3 - attempt === 1 ? "try" : "tries"} left).`);
          await new Promise((done) => setTimeout(done, 500));
        } else if (err instanceof MalformedToolInput) {
          ui.notice("The model sent malformed tool input; asking again.");
        } else {
          throw err;
        }
      }
    }
  };
}

type ClientSettings = { timeout: number; logger: typeof retryNotices; logLevel: "info" };

/** Claude, or DeepSeek through its Anthropic-compatible endpoint. */
function messagesApi(options: ModelOptions, settings: ClientSettings): Turn {
  const deepseek = options.model.startsWith("deepseek");
  const baseURL = options.baseURL ? { baseURL: options.baseURL } : {};
  // Anthropic() reads ANTHROPIC_API_KEY.
  const client = deepseek ? deepseekClient({ ...settings, ...baseURL }) : new Anthropic({ ...settings, ...baseURL });
  const request = deepseek ? deepseekRequest(options) : claudeRequest(options);
  return (messages, signal, summarize) => {
    const sent = deepseek ? withoutIsError(messages) : messages;
    // Tools stay declared (the history refers to them, and the cached prefix stays the same); "none" stops calls.
    const params: BetaMessageStreamParams = { ...request, messages: sent, ...(summarize && { tool_choice: { type: "none" } }) };
    return streamTurn(client, params, signal, summarize || options.quiet);
  };
}

/**
 * An OpenAI-compatible API: DeepSeek's (with DEEPSEEK_API_KEY), or OpenAI's or any other (OPENAI_API_KEY,
 * and --base-url or OPENAI_BASE_URL for its address; a local server may need no key at all).
 */
function chatCompletions(options: ModelOptions, settings: ClientSettings): Turn {
  if (options.model.startsWith("claude")) throw new Error("Claude models are reached through the Anthropic API: leave out --api openai.");
  const deepseek = options.model.startsWith("deepseek");
  if (deepseek && !process.env.DEEPSEEK_API_KEY) throw new Error("Set DEEPSEEK_API_KEY to use DeepSeek models.");
  const baseURL = options.baseURL ?? (deepseek ? DEEPSEEK_OPENAI_BASE_URL : process.env.OPENAI_BASE_URL);
  const apiKey = deepseek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY || (baseURL ? "none" : undefined);
  // Without an apiKey (no OPENAI_API_KEY, and OpenAI's own address) the SDK stops with an error naming the variable.
  const client = new OpenAI({ ...settings, apiKey, baseURL });
  // DeepSeek gets the output limit its Anthropic endpoint gets; elsewhere the server's default stands (OpenAI's
  // reasoning models refuse max_tokens).
  const chat = { ...options, maxTokens: deepseek ? 64_000 : undefined };
  return (messages, signal, summarize) => chatTurn(client, chat, messages, { signal, quiet: summarize || options.quiet, summarize });
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

function deepseekClient(settings: ConstructorParameters<typeof Anthropic>[0]): Anthropic {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY to use DeepSeek models.");
  // Without authToken: null, the SDK would also send ANTHROPIC_AUTH_TOKEN from the environment to DeepSeek.
  return new Anthropic({ ...settings, baseURL: DEEPSEEK_BASE_URL, apiKey, authToken: null });
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

/**
 * Whether a reply broke off partway: the connection dropped ("terminated"), the stream ended early, or the
 * server sent an error in the middle of it (for Claude, an overload or server error). A dropped connection
 * ended a whole Terminal-Bench task twice (milestone 10).
 */
function brokeOff(err: unknown): boolean {
  if (err instanceof ReplyBrokeOff) return true;
  for (const sdk of [Anthropic, OpenAI]) {
    // Failing before the reply began, the SDK has already retried; an abort is the user's.
    if (err instanceof sdk.APIConnectionError || err instanceof sdk.APIUserAbortError) return false;
  }
  if (err instanceof Anthropic.APIError) return err.status === undefined && ["overloaded_error", "api_error"].includes(String(err.type));
  if (err instanceof OpenAI.APIError) return err.status === undefined;
  // fetch's own error for a body cut off mid-stream, which the OpenAI SDK passes on as it is
  if (err instanceof TypeError) return err.message === "terminated";
  return (err instanceof Anthropic.AnthropicError || err instanceof OpenAI.OpenAIError) && /^terminated$|ended without/.test(err.message);
}

async function streamTurn(client: Anthropic, params: BetaMessageStreamParams, signal?: AbortSignal, quiet = false): Promise<ModelTurn> {
  const stream = client.beta.messages.stream(params, { signal });
  const rawInputs = new Map<number, string>(); // content block index -> tool input JSON as streamed
  let message: Anthropic.Beta.BetaMessage;

  if (!quiet) ui.status("thinking…");
  try {
    for await (const event of stream) {
      if (quiet) continue;
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") ui.status(`${block.name}…`);
        if (block.type === "fallback") ui.notice(`${block.from.model} declined; ${block.to.model} is continuing.`);
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") ui.text(delta.text);
        else if (delta.type === "thinking_delta") ui.thinking(delta.thinking);
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
    if (brokenJson && !(err instanceof Anthropic.APIError) && !brokeOff(err)) {
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
