import type Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir } from "./paths.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** One line of a session file. A start begins with type and cwd, which paths.ts reads without the rest. */
type Entry =
  | { type: "start"; cwd: string; model: string; date: string; system?: string; tools?: Anthropic.Beta.BetaTool[] }
  | { type: "message"; message: MessageParam }
  | { type: "compaction"; messages: MessageParam[] };

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
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  /** The messages a session file ended with. */
  static load(path: string): MessageParam[] {
    let messages: MessageParam[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      let entry: Entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // blank, or cut off by a crash mid-write
      }
      if (entry.type === "message") messages.push(entry.message);
      else if (entry.type === "compaction") messages = [...entry.messages];
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
 * If the session ended while tools were running, the last assistant message has tool calls with no
 * results, and the API would reject the history. Answer them as interrupted.
 */
function answerOpenToolCalls(messages: MessageParam[]): MessageParam[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return messages;
  const calls = last.content.filter((block) => block.type === "tool_use");
  if (calls.length === 0) return messages;
  const results = calls.map((call) => ({
    type: "tool_result" as const,
    tool_use_id: call.id,
    content: "Not run: the session ended before this call ran.",
    is_error: true,
  }));
  return [...messages, { role: "user", content: results }];
}
