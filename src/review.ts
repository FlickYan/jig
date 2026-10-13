// The reviewer (--reviewer): before a task ends, a second model checks the work against the task, in a
// context of its own and with the tools that only look, and the problems it finds go back to the model
// that did the work. For the failures the model doesn't see itself: milestone 23 found that most of
// deepseek-flash's end with it sure it is done, its own checks passed or never run.

import type Anthropic from "@anthropic-ai/sdk";
import { addUsage, runAgent, type Reviewer, type ReviewVerdict } from "./agent.ts";
import { Conversation } from "./conversation.ts";
import { type SubagentSetup, withRequest } from "./tools/subagent.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** A reviewer that runs a subagent loop on its own model (the setup's), with the review as its task. */
export function reviewer(model: string, setup: SubagentSetup): Reviewer {
  return {
    model,
    async review({ task, answer, messages }, signal) {
      const conversation = new Conversation(undefined, [{ role: "user", content: reviewPrompt(task, answer, workLog(messages)) }]);
      const result = await runAgent(conversation, { ...setup, ui: setup.ui("review") }, signal);
      let text = result.stop === "end_turn" ? result.text : "";
      // Out of steps, it is asked for its verdict on what it has checked (in milestone 24, three reviews in
      // five used their steps up and gave none). Cut off for any other reason, it gives none.
      if (result.stop === "max_steps") {
        const { message } = await setup.callModel(withRequest(conversation.messages, OUT_OF_STEPS), signal, { summarize: true });
        addUsage(result.usage, message.usage);
        text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      }
      const { verdict, problems } = verdictOf(text);
      return { verdict, ...(problems && { feedback: sentBack(problems) }), ...(verdict === "none" && { text }), usage: result.usage };
    },
  };
}

export function reviewPrompt(task: string, answer: string, work: string): string {
  return `Another agent was given the task below, worked on it, and now says it is done. Check that before the task ends: does the work do everything the task asks, exactly as it asks?

1. Read the task closely and list what it requires: what must exist or be produced, where and in what form, the inputs and cases it names, and anything that must stay as it was.
2. Check each requirement against the files and the system as they are now: read the code, the files it wrote and the output it left. You can only look. Besides the file tools, only commands that print or list files run (cat, ls, find, grep, head, tail, wc, diff, git log and the like); anything else, python, node, awk and the program itself included, is refused, so don't try it. Where only running something would tell, say what to run.
3. Report only problems you found evidence for, each with the requirement and what you saw. Leave out style, and improvements the task doesn't ask for.

Start your reply with APPROVED if every requirement is met, or with PROBLEMS: followed by the problems, one per line, the most serious first.

<task>
${task}
</task>

<the agent's last message>
${answer || "(none)"}
</the agent's last message>

<what the agent did, in order: its file changes and commands, without its reads>
${work || "(nothing)"}
</what the agent did>`;
}

/** What a review's reply says: the work approved, the problems found, or no verdict at all. */
export function verdictOf(text: string): { verdict: ReviewVerdict; problems?: string } {
  const header = /^\W*(APPROVED|PROBLEMS)\b[^\w\n]*/m.exec(text); // markdown around it, like **PROBLEMS:**
  if (!header) return { verdict: "none" };
  if (header[1] === "APPROVED") return { verdict: "approved" };
  const problems = text.slice(header.index + header[0].length).trim();
  return problems ? { verdict: "problems", problems } : { verdict: "none" };
}

const OUT_OF_STEPS = "You have run out of steps. Don't call any more tools: give your verdict now, on what you have checked, starting with APPROVED or PROBLEMS: as asked.";

/** Sent to the model that did the work, with the problems the review found. */
export function sentBack(problems: string): string {
  return `A reviewer, another model, checked your work against the task and reported these problems:

${problems}

It can be wrong: check each point against the task and the files, fix the ones that are real, and then finish.`;
}

const MAX_ENTRIES = 80;
const MAX_LOG = 12_000;

/**
 * What a run did, for the reviewer: each file change and command with how it ended (a command's exit code
 * and last line of output), in order and the most recent if there are many; reads and searches left out.
 */
export function workLog(messages: MessageParam[]): string {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const content = typeof block.content === "string" ? block.content : (block.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
      results.set(block.tool_use_id, { content, isError: !!block.is_error });
    }
  }
  const entries: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown>;
      const result = results.get(block.id);
      const failed = result?.isError ? " (failed)" : "";
      if (block.name === "bash") entries.push(`$ ${oneLine(String(input.command ?? ""), 300)}\n  ${howItEnded(result?.content ?? "")}`);
      else if (block.name === "write_file" || block.name === "edit_file") entries.push(`${block.name} ${String(input.path ?? "")}${failed}`);
      else if (!["read_file", "grep", "glob", "subagent", "memory", "skill"].includes(block.name)) entries.push(`${block.name}${failed}`);
    }
  }
  const kept = entries.slice(-MAX_ENTRIES);
  let log = kept.join("\n");
  if (log.length > MAX_LOG) log = `…\n${log.slice(-MAX_LOG)}`;
  return entries.length > kept.length ? `(${entries.length - kept.length} earlier entries left out)\n${log}` : log;
}

/** A command's ending, from bash's result: the exit code and the last line it printed. */
function howItEnded(content: string): string {
  const lines = content.trimEnd().split("\n");
  const end = lines.at(-1) ?? "";
  const output = lines.slice(0, -1).filter((line) => line.trim()).at(-1);
  return `→ ${end.replace(/^Exit code: /, "exit ")}${output ? `, last line: ${oneLine(output, 200)}` : ""}`;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
