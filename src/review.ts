// The reviewer (--reviewer): before a task ends, a second model checks the work against the task, in a
// context of its own and with the tools that only look, and the problems it finds go back to the model
// that did the work. For the failures the model doesn't see itself: milestone 23 found that most of
// deepseek-flash's end with it sure it is done, its own checks passed or never run. A review that runs the
// work instead, in a copy, is below; `jig review` (review-cli.ts) drives it.

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
      // Out of steps, or stopped for repeating itself, it is asked for its verdict on what it has checked (in
      // milestone 24, three reviews in five used their steps up and gave none). Cut off for any other reason,
      // it gives none.
      if (result.stop === "max_steps" || result.stop === "loop") {
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
  const header = /^\W*(?:(?:Verdict|VERDICT)\W*)?(APPROVED|PROBLEMS)\b[^\w\n]*/m.exec(text); // markdown around it, like **Verdict: PROBLEMS**
  if (!header) return { verdict: "none" };
  if (header[1] === "APPROVED") return { verdict: "approved" };
  const problems = text.slice(header.index + header[0].length).trim();
  const first = problems.split("\n")[0];
  // "PROBLEMS: None." and the like: a later APPROVED or PROBLEMS line, as a checklist has, gives the verdict.
  // Without one, the work is approved only if that first line says nothing more: "None of the tests pass"
  // is a problem.
  if (NONE.test(first)) {
    const later = verdictOf(problems.slice(first.length));
    if (later.verdict !== "none") return later;
    if (NO_PROBLEMS.test(first)) return { verdict: "approved" };
  }
  return problems ? { verdict: "problems", problems } : { verdict: "none" };
}

const NONE = /^\W*(?:none|no (?:problems|issues)|nothing|n\/a)\b/i;
const NO_PROBLEMS = /^\W*(?:none|no (?:problems|issues)|nothing|n\/a)(?: found| to report)?\W*$/i;

const OUT_OF_STEPS = "You have run out of steps. Don't call any more tools: give your verdict now, on what you have checked, starting with APPROVED or PROBLEMS: as asked.";

/** Sent to the model that did the work, with the problems the review found. */
export function sentBack(problems: string): string {
  return `A reviewer, another model, checked your work against the task and reported these problems:

${problems}

It can be wrong: check each point against the task and the files, fix the ones that are real, and then finish.`;
}

// A review that runs the work (jig review, milestone 29). Milestone 24's reviewer could only look, and of
// the failures it reviewed it approved the two that only running the work shows. This one runs it, in a
// copy of the machine the work was done on, so nothing it does reaches the work being judged.

/** A problem a review that ran the work found: what is wrong, and the command and output that show it. */
export interface Problem {
  what: string;
  command?: string;
  shows?: string;
}

/** What a review that runs the work is told: the task, the agent's last message, its work log and changes. */
export interface RunningReview {
  task: string;
  answer: string;
  log: string;
  /** The files that differ from the machine the agent started on (docker diff), if known. */
  changes?: string;
}

export function runningReviewPrompt(work: RunningReview, { minutes, steps, rechecked }: { minutes: number; steps: number; rechecked: boolean }): string {
  const evidence = rechecked
    ? "Each problem's command is run again in a fresh copy of the work, as the agent left it, and a problem is dropped unless the output contains its <shows>: so the command must set up whatever it needs itself, not rely on what your earlier commands did (a heredoc for a script is fine), and <shows> must be copied from what it printed."
    : "The command must work on its own in a fresh copy of the work, as the agent left it, since the agent may run it to see the problem for itself.";
  return `Another agent was given the task below, worked on it, and now says it is done. Check that by running the work: does it do everything the task asks, exactly as it asks?

Your commands run in a copy of the machine the agent worked on, made when it said it was done: its files as it left them, but none of the programs it left running (start what a check needs), and no network. You can run, change, install and start anything there: none of it reaches the agent's work, or what the work will be judged on.

1. Read the task closely and list what it requires: what must exist or be produced, where and in what form, the inputs and cases it names, and anything that must stay as it was.
2. Check each requirement by running something: the program on the task's own examples and the cases it names, the tests it mentions, a short script of your own. Read only to find out what to run.
3. You have about ${minutes} minutes and ${steps} replies: check what matters most first, put checks that don't depend on each other in one reply, and keep each command under a minute.

Then reply with APPROVED if every requirement you checked is met, or with PROBLEMS: and each problem you found, the most serious first, as

<problem>
<what>the requirement, and how the work fails it</what>
<command>one bash command that shows it</command>
<shows>an exact part of what that command printed that shows the problem</shows>
</problem>

Report only problems a command showed. ${evidence}

<task>
${work.task}
</task>

<the agent's last message>
${work.answer || "(none)"}
</the agent's last message>

<what the agent did, in order: its file changes and commands, without its reads>
${work.log || "(nothing)"}
</what the agent did>

<the files that differ from the machine the agent started on: A added, C changed, D deleted>
${work.changes || "(not known)"}
</the files that differ>`;
}

/** The problems in a running review's reply: its <problem> blocks, or else what follows PROBLEMS:, as one problem without evidence. */
export function problemsOf(text: string): Problem[] {
  const blocks = [...text.matchAll(/<problem>([\s\S]*?)<\/problem>/g)].map((match) => match[1]);
  if (blocks.length === 0) {
    const { problems } = verdictOf(text);
    return problems ? [{ what: problems }] : [];
  }
  return blocks.map((block) => ({ what: tag(block, "what") ?? block.split(/<(?:command|shows)>/)[0].trim(), command: unfenced(tag(block, "command")), shows: tag(block, "shows") }));
}

/** A field of a <problem>: to its closing tag or, where a model left that out, to the next field's tag. */
function tag(block: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)(?:</${name}>|(?=<(?:what|command|shows)>)|$)`).exec(block)?.[1].trim() || undefined;
}

/** A command as it would run: without the markdown fence a model may put around it. */
function unfenced(command?: string): string | undefined {
  const fenced = command && /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(command);
  return fenced ? fenced[1] : command;
}

/** Runs of whitespace as one space, so output copied across lines, or re-indented, still matches. */
const squeezed = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a problem holds in a fresh copy of the work: its command, run again there, prints what the review
 * said it showed. A problem without a command, or without output to look for, can't hold.
 */
export async function recheck(problem: Problem, run: (command: string) => Promise<string>): Promise<{ held: boolean; output?: string }> {
  if (!problem.command || !problem.shows) return { held: false };
  const output = await run(problem.command);
  return { held: squeezed(output).includes(squeezed(problem.shows)), output };
}

/** Sent to the model that did the work: the problems a running review found, each with its evidence. */
export function sentBackWithEvidence(problems: Problem[]): string {
  const indented = (text: string) => text.split("\n").map((line) => `      ${line}`).join("\n");
  const items = problems.map(({ what, command, shows }, i) =>
    command ? `${i + 1}. ${what}\n   It ran:\n${indented(command)}\n   and got:\n${indented(shows ?? "")}` : `${i + 1}. ${what}`,
  );
  return `A reviewer, another model, ran your work in a copy of this machine and reported these problems, with the commands that showed them and what they printed:

${items.join("\n\n")}

It can be wrong: check each point against the task and the files (you can run its commands yourself), fix the ones that are real, and then finish.`;
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
