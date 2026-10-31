// Calling the model. createModel returns one function, CallModel: the conversation in, the model's next
// message out, streamed to the terminal on the way. Claude and DeepSeek go through the Messages API, any
// other model through an OpenAI-compatible one (openai.ts). It retries what the SDK can't (a reply that
// broke off or went quiet, malformed tool input) and checks streamed tool input strictly before any tool sees it.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import OpenAI from "openai";
import { chatTurn, ReplyBrokeOff } from "./openai.ts";
import type { Mechanism } from "./stats.ts";
import type { Tool } from "./tools/index.ts";
import * as ui from "./ui.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

/** What --effort takes: how much the model thinks. Not every model takes all of them (DeepSeek: low, high, max). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** What Claude is asked for when --effort is left out. Other models then think as much as they do by default. */
const CLAUDE_EFFORT: Effort = "medium";

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

/**
 * The effort a request asks for: --effort's or, left out, CLAUDE_EFFORT for a model the Messages API
 * reaches as Claude (any but DeepSeek's), and none for the others.
 */
export function effortFor(model: string, api: Api, effort?: Effort): Effort | undefined {
  return effort ?? (api === "anthropic" && !model.startsWith("deepseek") ? CLAUDE_EFFORT : undefined);
}

/** What one model call returns. */
export interface ModelTurn {
  message: Anthropic.Beta.BetaMessage;
  /** Raw input of each tool call whose streamed JSON did not parse, keyed by tool_use id. */
  malformed: Map<string, string>;
  /**
   * The tools the request declared, by name. A model can call one it wasn't offered (milestone 28: 22 of
   * 30 attempts did, at a step that offered only the tools that edit), so the loop runs no other.
   */
  offered?: string[];
}

/**
 * One model call: the conversation in, the model's next message out, streamed to the terminal on the way.
 * With `summarize`, the model may not call tools and nothing is printed (used for compaction).
 */
export type CallModel = (messages: MessageParam[], signal?: AbortSignal, options?: { summarize?: boolean }) => Promise<ModelTurn>;

/** The model and how to reach it, and the system prompt and tools that go with every request. */
export interface ModelOptions {
  model: string;
  /** Print nothing while streaming (for subagents, whose work the user sees as a summary). */
  quiet?: boolean;
  /** Milliseconds to wait for the API to start answering (default: 2 minutes); for tests. */
  timeout?: number;
  /** Milliseconds a reply that has started may send nothing (default: JIG_STREAM_IDLE_MS, or 5 minutes); for tests. */
  idle?: number;
  /** Left out: medium for Claude, and the model's own default for others (see effortFor). */
  effort?: Effort;
  system: string;
  tools: Tool[];
  /** The API format (default: defaultApi). */
  api?: Api;
  /** The API's address, instead of the provider's own. */
  baseURL?: string;
  /** Told each time a request or a reply is tried again, for --stats. */
  count?(event: Mechanism): void;
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
 * How long a reply that has started may send nothing. The timeout above ends once it starts, and a server
 * can then hold the connection open with nothing in it: DeepSeek, under load, sends keep-alive comments
 * for up to 30 minutes. Only the reply's own events count (the SDKs pass on neither comments nor pings),
 * so after a minute without one jig says so, and after 5 minutes it asks again, as for a reply that broke
 * off. A model that thinks that long without showing anything would be asked again too, hence 5 minutes;
 * JIG_STREAM_IDLE_MS sets another limit.
 */
const IDLE_NOTICE_MS = 60_000;
const IDLE_LIMIT_MS = 300_000;

/** The idle limit: JIG_STREAM_IDLE_MS in milliseconds (0: none), or 5 minutes. */
function idleLimit(): number {
  const set = process.env.JIG_STREAM_IDLE_MS;
  if (!set) return IDLE_LIMIT_MS;
  const ms = Number(set);
  if (!Number.isInteger(ms) || ms < 0) throw new Error("JIG_STREAM_IDLE_MS must be a whole number of milliseconds (0: no limit).");
  return Math.min(ms, 2 ** 31 - 1); // setTimeout's longest wait, about 25 days
}

/**
 * Stops a reply that has gone quiet. Its signal is the caller's, and also aborts once the reply has sent
 * nothing for the limit. The turn calls alive() when the reply starts and at each event it sends.
 */
class Watchdog {
  readonly signal: AbortSignal;
  private readonly own = new AbortController();
  private readonly limit: number;
  private timers: NodeJS.Timeout[] = [];

  constructor(limit: number, signal?: AbortSignal) {
    this.limit = limit;
    this.signal = signal ? AbortSignal.any([signal, this.own.signal]) : this.own.signal;
  }

  /** Whether it stopped the reply. */
  get idle(): boolean {
    return this.own.signal.aborted;
  }

  /** The reply started, or sent an event: the clock starts again. */
  alive(): void {
    this.stop();
    if (!this.limit) return;
    const notice = Math.min(IDLE_NOTICE_MS, this.limit / 2);
    this.timers = [
      setTimeout(() => ui.notice(`No output from the API for ${duration(notice)}; still waiting, for up to ${duration(this.limit)}.`), notice),
      setTimeout(() => this.own.abort(), this.limit),
    ];
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }
}

/** 300_000 → "5 minutes", 400 → "0.4 seconds". */
function duration(ms: number): string {
  const [n, unit] = ms >= 60_000 ? [ms / 60_000, "minute"] : [ms / 1000, "second"];
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} ${unit}${rounded === 1 ? "" : "s"}`;
}

/**
 * The SDK retries rate limits, overloads, server errors and timeouts on its own, with backoff. It
 * reports each retry in its log; this turns those lines into notices, so a struggling API doesn't
 * look like a frozen agent, and counts them.
 */
export function retryNotices(count?: ModelOptions["count"]) {
  return {
    info(message: string) {
      const retry = /(timed out|failed with status (\d+)|failed).* - retrying, (\d+) attempts? remaining/.exec(message);
      if (!retry) return;
      count?.("retry.api");
      const what = retry[1] === "timed out" ? "didn't answer in time" : retry[2] ? `answered with status ${retry[2]}` : "couldn't be reached";
      ui.notice(`The API ${what}; trying again (${retry[3]} ${retry[3] === "1" ? "try" : "tries"} left).`);
    },
    debug() {},
    warn() {},
    error() {},
  };
}

type Turn = (messages: MessageParam[], watchdog: Watchdog, summarize: boolean) => Promise<ModelTurn>;

/**
 * The model, as a CallModel. A call is tried up to three times when the reply broke off, went quiet or
 * had malformed tool input; other errors go to the caller, after whatever retries the SDK made of them.
 */
export function createModel(options: ModelOptions): CallModel {
  const settings = { timeout: options.timeout ?? REQUEST_TIMEOUT_MS, logger: retryNotices(options.count), logLevel: "info" as const };
  const idle = options.idle ?? idleLimit();
  const turn = (options.api ?? defaultApi(options.model)) === "openai" ? chatCompletions(options, settings) : messagesApi(options, settings);

  return async (messages, signal, { summarize = false } = {}) => {
    for (let attempt = 1; ; attempt++) {
      const watchdog = new Watchdog(idle, signal);
      try {
        // Stopped once the reply is in or has failed: the wait before trying again isn't the API's.
        return await turn(messages, watchdog, summarize).finally(() => watchdog.stop());
      } catch (thrown) {
        // A reply the watchdog stopped broke off, whatever the SDK made of the abort.
        const err = watchdog.idle ? new ReplyBrokeOff(`no output from the API for ${duration(idle)}`) : thrown;
        // API errors are mostly not retried here: the SDK already retries rate limits, overloads and
        // requests that fail before a reply begins. What it can't retry is a reply that broke off partway,
        // or one with malformed tool input.
        if (attempt === 3 || signal?.aborted) throw err;
        if (brokeOff(err)) {
          options.count?.(watchdog.idle ? "retry.quiet" : "retry.brokeOff");
          const what = watchdog.idle ? `No output from the API for ${duration(idle)}` : "The reply broke off before it was finished";
          ui.notice(`${what}; trying again (${3 - attempt} ${3 - attempt === 1 ? "try" : "tries"} left).`);
          await new Promise((done) => setTimeout(done, 500));
        } else if (err instanceof MalformedToolInput) {
          options.count?.("retry.malformed");
          ui.notice("The model sent malformed tool input; asking again.");
        } else {
          throw err;
        }
      }
    }
  };
}

type ClientSettings = { timeout: number; logger: ReturnType<typeof retryNotices>; logLevel: "info" };

/** Claude, or DeepSeek through its Anthropic-compatible endpoint. */
function messagesApi(options: ModelOptions, settings: ClientSettings): Turn {
  const deepseek = options.model.startsWith("deepseek");
  const baseURL = options.baseURL ? { baseURL: options.baseURL } : {};
  // Anthropic() reads ANTHROPIC_API_KEY.
  const client = deepseek ? deepseekClient({ ...settings, ...baseURL }) : new Anthropic({ ...settings, ...baseURL });
  const request = deepseek ? deepseekRequest(options) : claudeRequest(options);
  return (messages, watchdog, summarize) => {
    const sent = deepseek ? withoutIsError(messages) : messages;
    // Tools stay declared (the history refers to them, and they and the system prompt stay cached); "none" stops calls.
    const params: BetaMessageStreamParams = { ...request, messages: sent, ...(summarize && { tool_choice: { type: "none" } }) };
    return streamTurn(client, params, watchdog, summarize || options.quiet);
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
  return (messages, watchdog, summarize) =>
    chatTurn(client, chat, messages, { signal: watchdog.signal, alive: () => watchdog.alive(), quiet: summarize || options.quiet, summarize });
}

function claudeRequest({ model, effort = CLAUDE_EFFORT, system, tools }: ModelOptions): Request {
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
  // --base-url wins (Terminal-Bench's adapter points it at a proxy that holds the key), but
  // ANTHROPIC_BASE_URL in the environment doesn't: that one is Anthropic's.
  return new Anthropic({ ...settings, baseURL: settings?.baseURL ?? DEEPSEEK_BASE_URL, apiKey, authToken: null });
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

/**
 * How each API says a request is too long for the model's context window. Kept to these wordings, since
 * each match costs a compaction: Anthropic's, OpenAI's (its message and its code), DeepSeek's and vLLM's,
 * Ollama's and llama.cpp's, and a stop reason some servers send as an error.
 */
const TOO_LONG = [
  /prompt is too long/, // Anthropic: "prompt is too long: 208310 tokens > 200000 maximum"
  /input length and `max_tokens` exceed context limit/, // Anthropic, with max_tokens counted in
  /maximum context length is \d+ tokens/, // OpenAI, DeepSeek, vLLM
  /exceeds the context window/, // OpenAI: "Your input exceeds the context window of this model."
  /\bcontext_length_exceeded\b/, // OpenAI's code
  /longer than the maximum model length/, // vLLM: "The decoder prompt (length 40000) is longer than ..."
  /prompt too long; exceeded (max )?context length/, // Ollama
  /exceeds the available context size/, // llama.cpp
  /\bmodel_context_window_exceeded\b/,
];

/**
 * Whether the API rejected a request as too long for the model. jig doesn't know every model's window, so
 * this is its word that the conversation must be compacted. A rate limit (429) never is, whatever it says.
 */
export function tooLong(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) || err.status === 429) return false;
  const code = err instanceof OpenAI.APIError ? err.code : undefined;
  return TOO_LONG.some((pattern) => pattern.test(`${err.message} ${code ?? ""}`));
}

/**
 * One streamed reply from the Messages API. Text and thinking go to the terminal as they arrive (unless
 * quiet); each tool call's input is kept as it streamed, to be checked strictly once the reply is complete.
 */
async function streamTurn(client: Anthropic, params: BetaMessageStreamParams, watchdog: Watchdog, quiet = false): Promise<ModelTurn> {
  const stream = client.beta.messages.stream(params, { signal: watchdog.signal });
  // Watched from when the reply starts: until then, the SDK's timeout applies.
  stream.on("connect", () => watchdog.alive());
  const rawInputs = new Map<number, string>(); // content block index -> tool input JSON as streamed
  let message: Anthropic.Beta.BetaMessage;

  if (!quiet) ui.status("thinking…");
  try {
    for await (const event of stream) {
      watchdog.alive();
      // Kept even when quiet: a subagent's or a reviewer's calls run too, so they are checked like any other.
      if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        rawInputs.set(event.index, (rawInputs.get(event.index) ?? "") + event.delta.partial_json);
      }
      if (quiet) continue;
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") ui.status(`${block.name}…`);
        if (block.type === "fallback") ui.notice(`${block.from.model} declined; ${block.to.model} is continuing.`);
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") ui.text(delta.text);
        else if (delta.type === "thinking_delta") ui.thinking(delta.thinking);
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
  const offered = (params.tools ?? []).flatMap((tool) => ("name" in tool ? [tool.name] : []));
  return { message: { ...message, content: dropDeclined(message.content) }, malformed, offered };
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
