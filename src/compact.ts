import type Anthropic from "@anthropic-ai/sdk";
import { type Conversation, estimateTokens } from "./conversation.ts";
import { type CallModel, tooLong } from "./model.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

const SUMMARY_REQUEST = `The conversation so far is about to be replaced by a summary to free up context, and the summary is all you will have to continue from. Write it now. Cover:
- What the user asked for, and their constraints and preferences (quote them where the wording matters).
- What has been done so far and what you found out: file paths, function names, commands, errors and how they were solved.
- The current state of every file you created or changed.
- What remains to be done, and the next step.
Be specific and complete, but don't copy whole files. Reply with the summary only.`;

const PREAMBLE = "The conversation so far was compacted to save context. This is its summary:";

/**
 * How large a copy of the history the summary request gets once the API has said the history is too long:
 * 0.7 of its size, and if that is still too long, 0.5. Each tool result kept in it is cut to its start
 * and its end.
 */
const SHRINK_STEPS = [0.7, 0.5];
const CUT_KEEPS = 500;

/**
 * How much of the task is restated after a summary: all of it, unless it is huge (about 5k tokens) without
 * the pinned text it holds; then its start and its end, since what it asks for is often last.
 */
const TASK_KEPT = 20_000;
const PINNED_HERE = '[this part follows word for word below, under "Still in effect from before the summary"]';

export interface CompactOptions {
  signal?: AbortSignal;
  /** Messages at the end to keep word for word after the summary, like a request the model hasn't seen yet. */
  keep?: MessageParam[];
  /** Compacting in the middle of a task: tell the model to carry on. */
  continueTask?: boolean;
  /** The task in hand, word for word, and a log of what was done for it: they follow the summary as they are. */
  task?: { text: string; log: string };
  /** The API has just rejected the history as too long: summarize from a shortened copy straight away. */
  tooLong?: boolean;
}

/**
 * Replaces the conversation with a summary the model writes of it. Nothing else is replayed: earlier
 * thinking blocks can't be sent again once the history before them has changed, and a fresh start is
 * valid for every provider. The summary request repeats the last request's system prompt, tools and
 * history, so the prompt cache makes it cheap; if the API rejects it as too long, the summary is written
 * from a copy with the tool output cut. Never call this while a tool call waits for its result.
 * Returns undefined when there is nothing to summarize.
 */
export async function compact(conversation: Conversation, callModel: CallModel, options: CompactOptions = {}) {
  const keep = options.keep ?? [];
  const history = conversation.messages.slice(0, conversation.messages.length - keep.length);
  if (history.length === 0) return undefined;
  const before = conversation.tokens;
  const { message, cut } = await summarize(history, callModel, options);
  const summary = message.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim();
  if (!summary) throw new Error("the model wrote no summary");
  // Pinned text (the instructions of skills in use) is kept word for word, not summarized.
  const pinned = [...conversation.pinned.values()];
  const task = options.task ? restated(options.task, pinned) : "";
  const kept = pinned.length ? `\n\nStill in effect from before the summary:\n\n${pinned.join("\n\n")}` : "";
  const next = options.continueTask ? "\n\nContinue the task from where it stopped." : "";
  conversation.replace([{ role: "user", content: `${PREAMBLE}\n\n${summary}${task}${kept}${next}` }, ...keep]);
  return { before, after: conversation.tokens, usage: message.usage, cut };
}

/**
 * The summary request, with the whole history unless the API has just rejected it as too long; then, and
 * whenever the API rejects the request itself as too long, with a shorter copy, down to the last size.
 */
async function summarize(history: MessageParam[], callModel: CallModel, options: CompactOptions) {
  const sizes = options.tooLong ? SHRINK_STEPS : [1, ...SHRINK_STEPS];
  for (let i = 0; ; i++) {
    const { messages, cut } = sizes[i] < 1 ? shortened(history, sizes[i]) : { messages: history, cut: 0 };
    try {
      const { message } = await callModel([...messages, { role: "user", content: SUMMARY_REQUEST }], options.signal, { summarize: true });
      return { message, cut };
    } catch (err) {
      if (i === sizes.length - 1 || !tooLong(err) || options.signal?.aborted) throw err;
    }
  }
}

/**
 * A copy of the history at most `size` times as large (as estimated), its tool results cut to their first
 * and last 500 characters, the oldest first, until it is, or as small as that makes it. Only the summary
 * request sees it: the history itself is replaced, never edited. jig's own tool results are text.
 */
function shortened(history: MessageParam[], size: number): { messages: MessageParam[]; cut: number } {
  let excess = estimateTokens(history) * (1 - size);
  let cut = 0;
  const messages = history.map((message): MessageParam => {
    if (excess <= 0 || typeof message.content === "string") return message;
    const content = message.content.map((block) => {
      if (excess <= 0 || block.type !== "tool_result" || typeof block.content !== "string" || block.content.length <= 3 * CUT_KEEPS) return block;
      const output = block.content;
      const short = `${output.slice(0, CUT_KEEPS)}\n[… ${output.length - 2 * CUT_KEEPS} characters cut to fit the summary request …]\n${output.slice(-CUT_KEEPS)}`;
      excess -= estimateTokens(output) - estimateTokens(short);
      cut++;
      return { ...block, content: short };
    });
    return { ...message, content };
  });
  return { messages, cut };
}

/**
 * The task and its log as they follow the summary, so a summary can't lose them. Pinned text the task
 * holds (a skill's instructions, with `/skill`) is only pointed to here, so it is there once and can't
 * crowd out the user's own words.
 */
function restated({ text, log }: { text: string; log: string }, pinned: string[]): string {
  for (const kept of pinned) text = text.replaceAll(kept, PINNED_HERE);
  const half = TASK_KEPT / 2;
  const task = text.length > TASK_KEPT ? `${text.slice(0, half)}\n[… ${text.length - TASK_KEPT} characters of the task left out …]\n${text.slice(-half)}` : text;
  const done = log ? `\n\nWhat you did for it before the summary, from your tool calls (each file change, and each command with how it ended):\n\n${log}` : "";
  return `\n\nThe task you are working on, word for word:\n\n${task}${done}`;
}
