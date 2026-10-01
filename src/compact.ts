import type Anthropic from "@anthropic-ai/sdk";
import type { Conversation } from "./conversation.ts";
import type { CallModel } from "./model.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

const SUMMARY_REQUEST = `The conversation so far is about to be replaced by a summary to free up context, and the summary is all you will have to continue from. Write it now. Cover:
- What the user asked for, and their constraints and preferences (quote them where the wording matters).
- What has been done so far and what you found out: file paths, function names, commands, errors and how they were solved.
- The current state of every file you created or changed.
- What remains to be done, and the next step.
Be specific and complete, but don't copy whole files. Reply with the summary only.`;

const PREAMBLE = "The conversation so far was compacted to save context. This is its summary:";

export interface CompactOptions {
  signal?: AbortSignal;
  /** Messages at the end to keep word for word after the summary, like a request the model hasn't seen yet. */
  keep?: MessageParam[];
  /** Compacting in the middle of a task: tell the model to carry on. */
  continueTask?: boolean;
}

/**
 * Replaces the conversation with a summary the model writes of it. Nothing else is replayed: earlier
 * thinking blocks can't be sent again once the history before them has changed, and a fresh start is
 * valid for every provider. The summary request repeats the last request's system prompt, tools and
 * history, so the prompt cache makes it cheap. Never call this while a tool call waits for its result.
 * Returns undefined when there is nothing to summarize.
 */
export async function compact(conversation: Conversation, callModel: CallModel, options: CompactOptions = {}) {
  const keep = options.keep ?? [];
  const history = conversation.messages.slice(0, conversation.messages.length - keep.length);
  if (history.length === 0) return undefined;
  const before = conversation.tokens;
  const { message } = await callModel([...history, { role: "user", content: SUMMARY_REQUEST }], options.signal, { summarize: true });
  const summary = message.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim();
  if (!summary) throw new Error("Compaction failed: the model wrote no summary.");
  // Pinned text (the instructions of skills in use) is kept word for word, not summarized.
  const pinned = [...conversation.pinned.values()];
  const kept = pinned.length ? `\n\nStill in effect from before the summary:\n\n${pinned.join("\n\n")}` : "";
  const next = options.continueTask ? "\n\nContinue the task from where it stopped." : "";
  conversation.replace([{ role: "user", content: `${PREAMBLE}\n\n${summary}${kept}${next}` }, ...keep]);
  return { before, after: conversation.tokens, usage: message.usage };
}
