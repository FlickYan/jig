import type Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir } from "./paths.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * One line of a session file. A start begins with type and cwd, which paths.ts reads without the rest. Each
 * line after the start also has `at`, the time it was written.
 */
type Entry =
  | { type: "start"; cwd: string; model: string; date: string; system?: string; tools?: Anthropic.Beta.BetaTool[] }
  | ({ type: "message"; message: MessageParam } & Timing)
  | { type: "compaction"; messages: MessageParam[] };

/**
 * How long the step behind a message took, in milliseconds, so a session shows where a task's time went:
 * the model call that wrote a reply (`ms`, retries included), or each tool call whose result the message
 * holds, by the call's id (`toolMs`; calls that only read run at the same time, so these can overlap).
 */
export interface Timing {
  ms?: number;
  toolMs?: Record<string, number>;
}

/** Where a project's sessions are kept: ~/.jig/sessions/<project key> (see projectKey). */
export function sessionDir(cwd: string): string {
  return projectDir("sessions", cwd);
}

/**
 * A conversation saved as JSON Lines: every message is appended the moment it exists, so a crash or
 * Ctrl+C loses nothing, and a compaction is recorded as an entry rather than by rewriting the file.
 */
export class SessionFile {
  readonly path: string;
  /** Written together with the first message, so a session nobody typed into leaves no file. */
  private start?: Entry;

  constructor(path: string, start?: Entry) {
    this.path = path;
    this.start = start;
  }

  static create(cwd: string, model: string): SessionFile {
    const stamp = new Date().toLocaleString("sv-SE").replace(" ", "T").replace(/:/g, "-");
    const path = join(sessionDir(cwd), `${stamp}-${Math.random().toString(16).slice(2, 6)}.jsonl`);
    return new SessionFile(path, { type: "start", cwd, model, date: new Date().toISOString() });
  }

  /** The project's session files, oldest first. */
  static list(cwd: string): string[] {
    const dir = sessionDir(cwd);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(dir, name));
  }

  /**
   * Records what the model is given besides the messages, its system prompt and tools, with the start of
   * the session, for jig sessions export. A resumed session keeps the record it began with.
   */
  describe(context: { system: string; tools: Anthropic.Beta.BetaTool[] }): void {
    if (this.start?.type === "start") this.start = { ...this.start, ...context };
  }

  write(entry: Entry): void {
    if (this.start) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(this.start)}\n`);
      this.start = undefined;
    }
    const { type, ...rest } = entry;
    appendFileSync(this.path, `${JSON.stringify({ type, at: new Date().toISOString(), ...rest })}\n`);
  }

  /** The messages a session file ended with; with `whole`, every message it holds, as if never compacted. */
  static load(path: string, whole = false): MessageParam[] {
    let messages: MessageParam[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      let entry: Entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // blank, or cut off by a crash mid-write
      }
      if (entry.type === "message") messages.push(entry.message);
      else if (entry.type === "compaction" && !whole) messages = [...entry.messages];
    }
    return answerOpenToolCalls(messages);
  }

  /** The first thing the user asked in a session, for listing sessions. */
  static firstRequest(path: string): string {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"role":"user"')) continue;
      const { message } = JSON.parse(line) as { message: MessageParam };
      if (typeof message.content === "string") return message.content;
    }
    return "";
  }
}

/**
 * If the session ended while tools were running, an assistant message has tool calls with no results, and
 * the API would reject the history. Answer them as interrupted, right after the calls. Not only at the end:
 * the answers aren't written to the file, so once a continued session goes on, the open calls are mid-file.
 */
function answerOpenToolCalls(messages: MessageParam[]): MessageParam[] {
  return messages.flatMap((message, i) => {
    if (message.role !== "assistant" || typeof message.content === "string") return [message];
    const next = messages[i + 1]?.content;
    const answered = new Set(Array.isArray(next) ? next.flatMap((block) => (block.type === "tool_result" ? [block.tool_use_id] : [])) : []);
    const results = message.content
      .filter((block) => block.type === "tool_use")
      .filter((call) => !answered.has(call.id))
      .map((call) => ({
        type: "tool_result" as const,
        tool_use_id: call.id,
        content: "Not run: the session ended before this call ran.",
        is_error: true,
      }));
    return results.length ? [message, { role: "user" as const, content: results }] : [message];
  });
}
