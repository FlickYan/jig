// Sessions as fine-tuning data. jig can't train a model, but the conversations it has had are what one
// would be trained on: this writes them in the format of OpenAI's chat fine-tuning, which open-source
// trainers read too. bench/export.ts uses it to keep only the attempts whose hidden tests passed.

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { WRAP_UP } from "./agent.ts";
import { toChatMessages } from "./openai.ts";
import { redactSecrets } from "./secrets.ts";
import { answerOpenToolCalls } from "./session.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** One training example: a conversation, and the tools the model had in it. */
export interface TrainingExample {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionFunctionTool[];
}

export interface ExportedSession {
  example: TrainingExample;
  /** How many things that looked like secrets were blanked out. */
  redacted: number;
  /** Whether the session recorded its system prompt and tools (sessions before milestone 14 didn't). */
  complete: boolean;
}

/**
 * A saved session as a training example: its system prompt and tools (as the session recorded them), and
 * every message in order, tool calls and their results included, up to the model's last finished reply.
 * The report jig asks for once the steps run out (WRAP_UP) isn't one: the work it reports on wasn't done.
 * The file keeps the whole history even where the conversation was compacted, so that is what's used. A
 * call a crash left open is answered as jig answered it when the session was continued (see SessionFile.load).
 * Thinking is left out (it isn't part of the format), and so is anything that looks like a secret.
 * Undefined if the model never finished a reply.
 */
export function exportSession(path: string): ExportedSession | undefined {
  let system = "";
  let tools: Anthropic.Beta.BetaTool[] | undefined;
  let messages: MessageParam[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let entry: { type: string; message?: MessageParam; system?: string; tools?: Anthropic.Beta.BetaTool[] };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // blank, or cut off by a crash mid-write
    }
    if (entry.type === "start") ({ system = "", tools } = entry);
    else if (entry.type === "message" && entry.message) messages.push(entry.message);
  }
  messages = answerOpenToolCalls(messages);
  const last = messages.findLastIndex((message, i) => message.role === "assistant" && !hasToolCalls(message) && messages[i - 1]?.content !== WRAP_UP);
  if (last === -1) return undefined;
  const chat = toChatMessages(system, messages.slice(0, last + 1))
    .filter((message) => message.role !== "system" || system)
    .map((message) => {
      if (message.role !== "assistant" || !("reasoning_content" in message)) return message;
      const { reasoning_content: _, ...rest } = message as typeof message & { reasoning_content?: string };
      return rest;
    });
  const example: TrainingExample = {
    messages: chat,
    ...(tools && { tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema as Record<string, unknown> } })) }),
  };
  const { value, count } = redact(example);
  return { example: value, redacted: count, complete: system !== "" && tools !== undefined };
}

/**
 * What makes an example invalid for chat fine-tuning: messages in an order the API wouldn't accept, so
 * neither would a trainer that follows it. Every tool result must answer a call of the assistant message
 * just before it, every call must get one, and the example must end with the assistant's reply.
 */
export function exampleProblems({ messages, tools }: TrainingExample): string[] {
  const problems: string[] = [];
  const names = new Set(tools?.map((tool) => tool.function.name));
  let open = new Set<string>();
  messages.forEach((message, index) => {
    if (message.role === "system" && index > 0) problems.push(`message ${index}: a system message after the start`);
    if (message.role === "tool") {
      if (!open.delete(message.tool_call_id)) problems.push(`message ${index}: a result for ${message.tool_call_id}, which no call before it is waiting for`);
      return;
    }
    if (open.size) problems.push(`message ${index}: ${[...open].join(", ")} got no result`);
    open = new Set();
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        open.add(call.id);
        if (tools && !names.has(call.function.name)) problems.push(`message ${index}: a call to ${call.function.name}, which isn't among the tools`);
      }
    }
  });
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.tool_calls?.length) problems.push("it doesn't end with the assistant's reply");
  return problems;
}

function hasToolCalls(message: MessageParam): boolean {
  return typeof message.content !== "string" && message.content.some((block) => block.type === "tool_use");
}

/** Every string in a value, redacted (strings, not the JSON text, so escapes can't be cut in half). */
function redact<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      const result = redactSecrets(item);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return { value: walk(value) as T, count };
}
