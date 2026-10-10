import type Anthropic from "@anthropic-ai/sdk";
import type { SessionFile } from "./session.ts";
import { FileVersions } from "./tools/util.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * One conversation with the model: its messages, what the model has read in it, how many tokens it
 * takes up, and the session file that keeps it on disk.
 */
export class Conversation {
  readonly messages: MessageParam[] = [];
  versions = new FileVersions();
  /** Size in tokens: measured at the last model call, plus an estimate for anything added since. */
  tokens = 0;
  /** Text that must survive compaction, like the instructions of skills in use, by key. */
  readonly pinned = new Map<string, string>();
  private readonly session?: SessionFile;

  constructor(session?: SessionFile, messages: MessageParam[] = []) {
    this.session = session;
    this.messages.push(...messages);
    this.tokens = estimateTokens(messages);
  }

  get sessionPath(): string | undefined {
    return this.session?.path;
  }

  pin(key: string, text: string): void {
    this.pinned.set(key, text);
  }

  /** What the model is given besides the messages, for the session file to record. */
  describe(context?: { system: string; tools: Anthropic.Beta.BetaTool[] }): void {
    if (context) this.session?.describe(context);
  }

  push(message: MessageParam): void {
    this.messages.push(message);
    this.tokens += estimateTokens(message.content);
    this.session?.write({ type: "message", message });
  }

  /** Starts over from `messages`, after compaction. The session file still has the full history. */
  replace(messages: MessageParam[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
    this.tokens = estimateTokens(messages);
    this.versions = new FileVersions(); // the files the model read are no longer in its context
    this.session?.write({ type: "compaction", messages });
  }
}

/** A rough token count (about 4 characters per token), for what hasn't been measured by the API yet. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}
