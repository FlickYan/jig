// The agent loop (runAgent), and what happens around one tool call: checking the model's input, the
// user's hooks, the permission policy, running the tool and trimming its output. The CLI and subagents
// drive the same loop; what differs between them comes in through AgentOptions.

import type Anthropic from "@anthropic-ai/sdk";
import { lstatSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { compact, type CompactOptions } from "./compact.ts";
import type { Conversation } from "./conversation.ts";
import { type CallModel, tooLong } from "./model.ts";
import { workLog } from "./review.ts";
import type { Sandbox } from "./sandbox.ts";
import type { Mechanism } from "./stats.ts";
import { type OutputFiles, whyStopped, withoutOutputFileNames } from "./tools/bash.ts";
import { checkInput, truncate, type Tool, type ToolInput } from "./tools/index.ts";
import { isInside } from "./tools/util.ts";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** What the loop reports as it goes. The CLI prints it; tests record it. */
export interface AgentUI {
  /** `id` tells calls apart: calls that only read run at the same time, so results can come in any order. */
  toolCall(name: string, description: string, id: string): void;
  toolResult(output: string, isError: boolean, id: string): void;
  notice(text: string): void;
}

/** How a run of the loop is set up: the model, the tools, and the checks every tool call goes through. */
export interface AgentOptions {
  callModel: CallModel;
  tools: Tool[];
  cwd: string;
  /**
   * Hard stop: the most steps one task may take, each a model call that may call tools. With wrapUp, one
   * more call, in which no tool runs, follows the last.
   */
  maxSteps: number;
  /** Compact the conversation before a model call once it is larger than this many tokens (0: never). */
  compactAt: number;
  /** Guardrail, asked before every tool call: resolves to the reason it may not run, or null if it may. */
  authorize(tool: Tool, input: ToolInput): Promise<string | null>;
  /** Where commands run, if not directly on the machine. */
  sandbox?: Sandbox;
  /** Where bash keeps the whole of an output too long to show, for the model to search. */
  outputs?: OutputFiles;
  /** Directories outside the project the file tools may use too (--add-dir). */
  dirs?: string[];
  /** Paths the settings hide (hiddenPaths), which the file tools refuse too. */
  hidden?: string[];
  /** What the sandbox locks in the repository, which the file tools refuse too (see lockedGitPaths). */
  gitLocked?: string[];
  /** After write_file and edit_file, check what they wrote and tell the model what is wrong (--check-writes). */
  checkWrites?: boolean;
  /** Whether the permission policy would run a bash command without asking: where --check-writes may run its programs. */
  mayRun?(command: string): boolean;
  /** Let edit_file apply a unique match that differs in typographic punctuation or trailing whitespace (--tolerant-edits). */
  tolerantEdits?: boolean;
  /** The user's hooks around tool calls (see hooks.ts). */
  hooks?: ToolHooks;
  /**
   * Sent once, the first time the model stops with a step left, so it checks its work before the task ends.
   * For one-shot runs, where nobody is there to look at the result and ask for more.
   */
  review?: string;
  /** A stronger model that takes over the steps left once a test command the model ran fails (--escalate). */
  escalate?: { model: string; callModel: CallModel };
  /** A second model that checks the work against the task the first time the model stops (--reviewer). */
  reviewer?: Reviewer;
  /**
   * With --time-limit, the time (as Date.now() gives it) after which neither the reviewer nor `review`'s
   * request starts, nor does finishGate look: closer to the limit, there may be no time to act on what they
   * find (in milestone 9, --check ran tasks out of time), so the answer stands.
   */
  checkUntil?: number;
  /**
   * Budget notes (on unless --no-budget-notes): once half the steps are used, or half the time when there is a `deadline` (--time-limit;
   * with `begun`, when the task began, as Date.now() gives them), a note after each step's tool results says
   * how much is used, and before the last step that it is the last (see budgetNote). Only a task's own loop
   * has them: a subagent's or the reviewer's steps are their own.
   */
  budgetNotes?: { begun: number; deadline?: number };
  /**
   * --finish-gate: the first time the model stops with a step left, before checkUntil, what the task's own
   * calls did, with no model call, may send it back once (see finishGap): a file changed after the last
   * command that ran something, or a last test run that failed. `changed` lists the project's files the task
   * changed (by the snapshot taken before it, relative to `cwd`), so that changes commands made count too.
   * Only a task's own loop has it: a subagent's or the reviewer's answer doesn't end the task.
   */
  finishGate?: { changed?(): string[] | undefined };
  /**
   * The settings' Stop hooks (see hooks.ts), asked each time the model gives its final answer with a step
   * left (and, once they have sent the model back, on the last step too, only to say whether they still
   * object): resolves to why the task isn't done, which the model is told, or null. `active` says whether they
   * have sent the model back already in this task. Only a task's own loop has them: a subagent's or the
   * reviewer's answer doesn't end the task.
   */
  stopHooks?(stop: { task: string; answer: string; active: boolean; session?: string }, signal?: AbortSignal): Promise<string | null>;
  /**
   * Out of steps mid-task, ask the model once more, without tools, what it changed, what it verified and
   * what is left (WRAP_UP), so the run doesn't end on a tool result. Off for subagents and the reviewer,
   * which ask for their own, and with --no-wrap-up.
   */
  wrapUp?: boolean;
  /** Told each time one of the loop's mechanisms fires (compaction, the wrap-up, ...), for --stats. */
  count?(event: Mechanism): void;
  ui: AgentUI;
}

/** A model that reviews the work before the task ends (see review.ts). */
export interface Reviewer {
  model: string;
  /**
   * Resolves to its verdict, what the model is told about the problems it found (if it found any), and the
   * tokens it took. It is given the task, the model's last message, and this run's messages from the task on.
   */
  review(work: { task: string; answer: string; messages: Anthropic.Beta.BetaMessageParam[] }, signal?: AbortSignal): Promise<{ verdict: ReviewVerdict; feedback?: string; text?: string; usage: Usage }>;
}

/** Approved, problems found (and sent back), or no verdict (out of steps, say): then the work stands. */
export type ReviewVerdict = "approved" | "problems" | "none";

/** The user's hooks, as the loop sees them (the CLI builds them from the settings). */
export interface ToolHooks {
  /** Before a call runs: resolves to why it is blocked, or null. Ctrl+C (`signal`) stops the hooks. */
  before(tool: string, input: ToolInput, signal?: AbortSignal): Promise<string | null>;
  /** After a call ran: resolves to feedback for the model about the result, or null. */
  after(tool: string, input: ToolInput, output: string, signal?: AbortSignal): Promise<string | null>;
}

/** Tokens, summed over a run's model calls. */
export interface Usage {
  input: number; // uncached input tokens
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** How a run ended. */
export interface RunResult {
  /**
   * Why the loop ended: the last reply's stop_reason (end_turn, max_tokens, refusal, ...), or one of ours.
   * "loop": the model made the same calls and got the same results, SAME_STEPS steps in a row.
   * "empty": asked to go on after a reply with no text or tool call, it gave another, so there is no answer.
   * "unapproved" is the CLI's: it stops a task whose tool calls keep needing an approval nobody can give.
   * So is "time_limit": it stops a task at --time-limit.
   */
  stop: Anthropic.Beta.BetaStopReason | "max_steps" | "interrupted" | "loop" | "empty" | "unapproved" | "time_limit";
  /**
   * Text of the final reply, after that of the replies it continues if they were cut off at the output limit.
   * At max_steps, the wrap-up's, if there was one (see AgentOptions.wrapUp).
   */
  text: string;
  steps: number;
  /** Every model call's tokens, the escalation's included. */
  usage: Usage;
  /** Which model took over, at which step, and the tokens of its calls. */
  escalated?: { model: string; step: number; usage: Usage };
  /** The review: by which model, after which step, its verdict, and its tokens. */
  reviewed?: { model: string; step: number; verdict: ReviewVerdict; usage: Usage };
}

/**
 * The agent loop: call the model, run the tools it asks for, send back the results, and repeat until
 * it replies without asking for a tool.
 *
 * The conversation ends with the user's new message. The loop only ever appends to it, apart from
 * compaction, which replaces it whole: rewriting earlier messages would throw away the prompt cache and
 * invalidate the model's earlier thinking blocks.
 */
export async function runAgent(conversation: Conversation, opts: AgentOptions, signal?: AbortSignal): Promise<RunResult> {
  const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let escalated: RunResult["escalated"];
  let review: RunResult["reviewed"];
  const result = (stop: RunResult["stop"], steps: number, text = ""): RunResult => ({ stop, text, steps, usage, ...(escalated && { escalated }), ...(review && { reviewed: review }) });
  // Whether the work was checked (by --check's request or a reviewer): it is, at most once a run. And how
  // often the Stop hooks have sent the model back: MAX_STOP_BLOCKS times at most.
  let reviewed = false;
  let stopBlocks = 0;
  // Replies that weren't answers: whether the model was asked again after one with no text or tool call,
  // how many cut off at the output limit it was asked to continue, and the text of those so far.
  let askedAgain = false;
  let continued = 0;
  let unfinished = "";
  // The task is the message the run starts from; a reviewer sees it and what the run did after it (all
  // there is, if a compaction has replaced it with a summary).
  const taskMessage = conversation.messages.at(-1);
  const task = textOf(taskMessage);
  const sinceTask = () => conversation.messages.slice(Math.max(0, conversation.messages.indexOf(taskMessage!)));
  // The first step compaction may run at (it waits a few steps after one that failed), and what the run did
  // before the last one, for the log that follows a summary.
  let compactFrom = 1;
  let compactedWork: MessageParam[] = [];
  // The last step's calls and results, and how many steps in a row have had the same.
  let lastStep = "";
  let sameSteps = 0;
  // --finish-gate: whether it has looked at the work yet, and what the task's calls did (see Trail).
  let gated = false;
  const trail: Trail = { changed: [] };

  /**
   * Compacts; resolves to whether there was anything to compact. Unless the task is the request kept after
   * the summary, the task and a log of what was done for it follow the summary word for word.
   */
  const compactNow = async (rejected: boolean): Promise<boolean> => {
    const work = [...compactedWork, ...sinceTask()];
    const restate = conversation.messages.at(-1) !== taskMessage ? { text: task, log: workLog(work) } : undefined;
    const compacted = await compactConversation(conversation, opts, { task: restate, tooLong: rejected, signal });
    if (!compacted) return false;
    opts.count?.("compaction");
    addUsage(usage, compacted.usage);
    compactedWork = work;
    // A cut-off reply is only in the summary now, so the next reply can't continue it: it stands alone.
    unfinished = "";
    return true;
  };

  for (let step = 1; step <= opts.maxSteps; step++) {
    let reply: Message;
    let malformed: Map<string, string>;
    let offered: string[] | undefined;
    let began = 0; // when the call that gave the reply began, for the session file
    try {
      if (opts.compactAt > 0 && conversation.tokens > opts.compactAt && step >= compactFrom) {
        try {
          await compactNow(false);
        } catch (err) {
          if (signal?.aborted) throw err;
          // A failed summary needn't end the task: the conversation may still fit, so it goes on as it is.
          compactFrom = step + COMPACT_AGAIN_AFTER;
          opts.count?.("compaction.failed");
          opts.ui.notice(`Compaction failed (${errorMessage(err)}), so the conversation goes on as it is; compacting again from step ${compactFrom}.`);
        }
      }
      const callModel = escalated ? opts.escalate!.callModel : opts.callModel;
      try {
        began = Date.now();
        ({ message: reply, malformed, offered } = await callModel(conversation.messages, signal));
      } catch (err) {
        // The API's word that the conversation is too long for the model, whose window jig may not know:
        // compacted, it may fit, so the call is made again, once. If it can't be compacted, the error stands.
        if (signal?.aborted || opts.compactAt === 0 || !tooLong(err)) throw err;
        opts.count?.("compaction.tooLong");
        opts.ui.notice("The API says the conversation is too long for the model; compacting it and asking again.");
        // The request can't be made without it, so a summary that fails ends the task, saying it was that.
        const compacted = await compactNow(true).catch((failed: unknown) => {
          throw new Error(`Compaction failed: ${errorMessage(failed)}`);
        });
        if (!compacted) throw err;
        began = Date.now();
        ({ message: reply, malformed, offered } = await callModel(conversation.messages, signal));
      }
    } catch (err) {
      if (signal?.aborted) return result("interrupted", step - 1);
      throw err;
    }
    const ms = Date.now() - began;
    addUsage(usage, reply.usage);
    if (escalated) addUsage(escalated.usage, reply.usage);

    // A safety classifier declined, even after the fallback model. Whatever was streamed before the
    // decline is not a real answer, so it stays out of the history.
    if (reply.stop_reason === "refusal") {
      opts.count?.("reply.refused");
      return result("refusal", step);
    }

    const calls = reply.content.filter((block): block is ToolUse => block.type === "tool_use");
    // A step without calls ends a run of identical ones: what follows it (a request to go on, or to check
    // the work, or a reviewer's problems) gives the model something new to act on.
    if (calls.length === 0) lastStep = "";
    // The reply's text, after that of the replies it continues if they were cut off at the output limit.
    const answer = unfinished + replyText(reply);
    unfinished = "";
    // A reply with neither text nor a tool call (empty, or only thinking) answers nothing, and as a message
    // it would make every later request invalid: the API rejects an assistant message with no content. So
    // it stays out of the history, and the model is asked once a run to go on.
    if (calls.length === 0 && !replyText(reply).trim()) {
      conversation.tokens = contextSize(reply.usage) - reply.usage.output_tokens; // the request, without the reply
      if (!askedAgain && step < opts.maxSteps && (reply.stop_reason === "end_turn" || reply.stop_reason === "max_tokens")) {
        askedAgain = true;
        opts.count?.("reply.empty");
        opts.ui.notice("The model replied without text or a tool call; asking it to go on.");
        conversation.push({ role: "user", content: reply.stop_reason === "max_tokens" ? CUT_OFF_BEFORE_ANSWER : EMPTY_REPLY });
        continue;
      }
      // A reply cut off, or out of context, ends the run with that reason. One that simply stopped isn't a
      // finished task, nor an answer for --check, the reviewer or the Stop hooks to check: the run ends as
      // "empty", or on the last step as out of steps, with the wrap-up any other last step gets.
      const stop = reply.stop_reason && reply.stop_reason !== "end_turn" ? reply.stop_reason : "empty";
      if (stop === "empty" && step === opts.maxSteps) {
        opts.ui.notice("The model replied without text or a tool call on the last step.");
        break;
      }
      opts.ui.notice("The model replied without text or a tool call, so the task ends without an answer.");
      return result(stop, step, answer);
    }

    conversation.push({ role: "assistant", content: reply.content }, { ms });
    conversation.tokens = contextSize(reply.usage); // measured: the whole request plus this reply
    // A reply with no tool calls is the final answer, unless the work is still to be checked.
    if (calls.length === 0) {
      // Cut off at the output limit: what it holds is valid history, so the model is asked for the rest.
      if (reply.stop_reason === "max_tokens" && continued < MAX_CONTINUATIONS && step < opts.maxSteps) {
        continued++;
        unfinished = answer;
        opts.count?.("reply.continued");
        opts.ui.notice("The reply was cut off at the output limit; asking the model to continue.");
        conversation.push({ role: "user", content: CONTINUE });
        continue;
      }
      // Once, at the first stop with a step left, before --check and the reviewer: if the task's own calls
      // show work the model hasn't checked, it is told what, and goes on. Not too close to the time limit,
      // where --check and the reviewer don't start either: what it is sent back for might not get done.
      if (opts.finishGate && !gated && reply.stop_reason === "end_turn" && step < opts.maxSteps) {
        gated = true;
        const late = opts.checkUntil !== undefined && Date.now() >= opts.checkUntil;
        const gap = late ? undefined : finishGap(trail, opts.cwd, opts.finishGate.changed?.());
        if (late) opts.count?.("finishGate.skipped");
        if (gap) {
          opts.count?.("finishGate");
          opts.ui.notice(`Sending the model back once (--finish-gate): "${gap}"`);
          conversation.push({ role: "user", content: `(Note from jig: ${gap})` });
          continue;
        }
      }
      // Too close to the time limit, the work isn't checked, now or at a later stop, which would be closer still.
      const checking = !!(opts.reviewer || opts.review) && !reviewed && reply.stop_reason === "end_turn" && step < opts.maxSteps;
      if (checking && opts.checkUntil !== undefined && Date.now() >= opts.checkUntil) {
        reviewed = true;
        opts.count?.(opts.reviewer ? "review.skipped" : "check.skipped");
        opts.ui.notice("Too little time is left to check the work (--time-limit), so it stands as it is.");
      }
      // By a second model, once, while there are steps left to act on what it finds.
      if (opts.reviewer && !reviewed && reply.stop_reason === "end_turn" && step < opts.maxSteps) {
        reviewed = true;
        const { model } = opts.reviewer;
        opts.count?.("review");
        opts.ui.notice(`${model} is reviewing the work.`);
        try {
          const found = await opts.reviewer.review({ task, answer, messages: sinceTask() }, signal);
          addUsages(usage, found.usage);
          if (signal?.aborted) return result("interrupted", step);
          review = { model, step, verdict: found.verdict, usage: found.usage };
          if (found.feedback) {
            opts.count?.("review.problems");
            opts.ui.notice(`${model} found problems; the model takes them up.`);
            conversation.push({ role: "user", content: found.feedback });
            continue;
          }
          // Quoted as a Stop hook is, below: marked as cut only if it was.
          const quoted = found.text?.trim().replace(/\s+/g, " ");
          const said = quoted ? ` (it said: "${quoted.length > 160 ? `${quoted.slice(0, 160)}…` : quoted}")` : "";
          opts.ui.notice(found.verdict === "approved" ? `${model} found no problems.` : `${model} gave no verdict${said}, so the work stands as it is.`);
        } catch (err) {
          if (signal?.aborted) return result("interrupted", step);
          // A review that failed leaves the work as it is: it was only a check.
          opts.ui.notice(`The review failed (${err instanceof Error ? err.message : String(err)}), so the work stands as it is.`);
        }
      } else if (opts.review && !reviewed && reply.stop_reason === "end_turn" && step < opts.maxSteps) {
        // Or by the model itself, once, likewise with a step left: asked on the last, it couldn't reply, and
        // the answer it gave would be lost.
        reviewed = true;
        opts.count?.("check");
        opts.ui.notice("Checking the work before finishing.");
        conversation.push({ role: "user", content: opts.review });
        continue;
      }
      // Then the project's own check, its Stop hooks, at every stop with a step left to act on what they say;
      // on the last step too once they have sent the model back, so the task doesn't end as if they passed.
      if (opts.stopHooks && reply.stop_reason === "end_turn" && (step < opts.maxSteps || stopBlocks > 0)) {
        let blocked: string | null = null;
        try {
          blocked = await opts.stopHooks({ task, answer, active: stopBlocks > 0, session: conversation.sessionPath }, signal);
        } catch (err) {
          // As with a hook that fails, the work stands: the hooks were only a check.
          if (!signal?.aborted) opts.ui.notice(`The Stop hooks failed (${errorMessage(err)}), so the task ends.`);
        }
        if (signal?.aborted) return result("interrupted", step);
        if (blocked) {
          const short = blocked.trim().replace(/\s+/g, " ");
          const said = `"${short.length > 160 ? `${short.slice(0, 160)}…` : short}"`;
          if (stopBlocks < MAX_STOP_BLOCKS && step < opts.maxSteps) {
            stopBlocks++;
            opts.count?.("hook.stopBlocked");
            opts.ui.notice(`A Stop hook says the task isn't done (${said}); the model goes on (${stopBlocks} of ${MAX_STOP_BLOCKS}).`);
            // A test suite's whole output can be long, so it is cut like a tool's.
            conversation.push({ role: "user", content: stopBlocked(truncate(blocked)) });
            continue;
          }
          opts.count?.("hook.stopCapped");
          const why = step < opts.maxSteps ? `it has sent the model back ${MAX_STOP_BLOCKS} times` : "no step is left (--max-steps)";
          opts.ui.notice(`A Stop hook still says the task isn't done (${said}), but ${why}, so the task ends.`);
        }
      }
      return result(reply.stop_reason ?? "end_turn", step, answer);
    }

    // Every tool call gets a result, even ones that never run, or the next request is invalid.
    const cutOff = reply.stop_reason !== "tool_use"; // e.g. max_tokens: the last call's input may be incomplete
    const reads = (call: ToolUse) => opts.tools.find((t) => t.definition.name === call.name)?.kind === "read";
    // A call identical to an earlier one in the same reply doesn't run, unless a call between them may have
    // changed something: it could only do the same again, or fail for having been done (one reply in
    // milestone 27 held the same edit 208 times). A test run after an edit runs again.
    const keys = calls.map((call) => callKey(call, malformed.get(call.id)));
    const earlier = new Map<string, number>(); // the calls since the last that may have changed something
    const repeats = calls.map((call, i) => {
      const first = earlier.get(keys[i]);
      if (first !== undefined) return first + 1;
      if (!reads(call)) earlier.clear();
      earlier.set(keys[i], i);
      return undefined;
    });
    // How long each call took, by id, for the session file, and when it ended, for --finish-gate.
    const toolMs: Record<string, number> = {};
    const ended: Record<string, number> = {};
    const handle = (call: ToolUse, i: number) => {
      const started = Date.now();
      return handleToolCall(call, { cutOff, malformed: malformed.get(call.id), offered, repeats: repeats[i] }, conversation, opts, usage, signal).finally(() => {
        ended[call.id] = Date.now();
        toolMs[call.id] = ended[call.id] - started;
      });
    };
    // Calls that only read (searches, file reads, subagents) can't interfere with each other, so they
    // run at the same time. Anything else runs in order, since one call may depend on another's effect.
    const readOnly = calls.every(reads);
    const results: ToolResult[] = [];
    try {
      if (readOnly) results.push(...(await Promise.all(calls.map(handle))));
      else for (const [i, call] of calls.entries()) results.push(await handle(call, i));
    } catch (err) {
      // handleToolCall turns failures into results, so only a bug in jig gets here. The error still ends
      // the task, but the calls left open get a result first, so the conversation can go on afterwards.
      const answered = new Set(results.map((result) => result.tool_use_id));
      const content = `No result: jig failed while handling this call (${errorMessage(err)}).`;
      const open = calls.filter((call) => !answered.has(call.id)).map((call): ToolResult => ({ type: "tool_result", tool_use_id: call.id, content, is_error: true }));
      conversation.push({ role: "user", content: [...results, ...open] }, { toolMs });
      throw err;
    }
    // With budget notes, what is left of the budget goes in the results' message, after them: an earlier
    // message would change the cached prefix. Not once the task is stopped: the model won't see it.
    const note = opts.budgetNotes && !signal?.aborted ? budgetNote(step, opts.maxSteps, opts.budgetNotes) : undefined;
    if (note) opts.count?.(note === LAST_STEP ? "budgetNote.lastStep" : "budgetNote");
    const content: MessageParam["content"] = note ? [...results, { type: "text", text: note }] : results;
    conversation.push({ role: "user", content }, { toolMs }); // all results for one reply go in one message
    // What each call did, in the order they ran, for --finish-gate to look at when the model stops.
    if (opts.finishGate) for (const [i, call] of calls.entries()) follow(trail, call, results[i], ended[call.id]);

    // A failed test run is the model's own check saying the work isn't right yet: the stronger model takes
    // the steps left, with the whole conversation, so it starts where the first one stopped.
    if (opts.escalate && !escalated && step < opts.maxSteps && calls.some((call, i) => failedTestRun(call, results[i]))) {
      escalated = { model: opts.escalate.model, step: step + 1, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
      opts.count?.("escalated");
      opts.ui.notice(`A test run failed: ${opts.escalate.model} takes over from step ${step + 1}.`);
    }

    if (signal?.aborted) return result("interrupted", step);

    // The same calls with the same results, step after step: what the model sees doesn't change, so neither
    // will what it does, and it would spend the steps left on them (milestone 27's trained model made the
    // same call 5 or more times in a row in 25 of 69 attempts). The results count, so polling that gets
    // somewhere isn't stopped. A long output's file has a new name each time, which doesn't count.
    const same = (content: ToolResult["content"]) => (typeof content === "string" ? withoutOutputFileNames(content) : content);
    const thisStep = JSON.stringify(calls.map((_, i) => [keys[i], same(results[i].content), results[i].is_error]));
    sameSteps = thisStep === lastStep ? sameSteps + 1 : 1;
    lastStep = thisStep;
    if (sameSteps >= SAME_STEPS) {
      opts.count?.("loop");
      return result("loop", step);
    }
  }
  if (!opts.wrapUp) return result("max_steps", opts.maxSteps);

  // Out of steps, the last reply's calls answered: one more call, with the tools declared but none allowed
  // (summarize), asks where the work stands. It is a report, not more work, so if it fails or says
  // nothing, the run ends as it would have without it, and the request stays out of the history.
  opts.count?.("wrapUp");
  opts.ui.notice("Out of steps: asking the model where the work stands.");
  const request: MessageParam = { role: "user", content: WRAP_UP };
  const callModel = escalated ? opts.escalate!.callModel : opts.callModel;
  let report: Message;
  const asked = Date.now();
  // The note after an empty reply, if it is last, asked for a tool call and was never answered: the request
  // takes it back, as a subagent's or the reviewer's does (withRequest).
  const last = conversation.messages.at(-1)?.content;
  const sent = typeof last === "string" && AFTER_EMPTY.includes(last) ? conversation.messages.slice(0, -1) : conversation.messages;
  try {
    ({ message: report } = await callModel([...sent, request], signal, { summarize: true }));
  } catch (err) {
    if (signal?.aborted) return result("interrupted", opts.maxSteps);
    opts.ui.notice(`The wrap-up failed (${errorMessage(err)}), so the task ends without one.`);
    return result("max_steps", opts.maxSteps);
  }
  addUsage(usage, report.usage);
  if (escalated) addUsage(escalated.usage, report.usage);
  const text = replyText(report);
  if (report.stop_reason === "refusal" || !text.trim()) return result("max_steps", opts.maxSteps);
  conversation.push(request);
  // A server can ignore tool_choice: a call here would never run, and unanswered it would make every
  // later request invalid, so it is left out.
  conversation.push({ role: "assistant", content: report.content.filter((block) => block.type !== "tool_use") }, { ms: Date.now() - asked });
  conversation.tokens = contextSize(report.usage);
  return result("max_steps", opts.maxSteps, text);
}

/** What the model is told after a reply that wasn't an answer, and how often a cut-off one is continued. */
const EMPTY_REPLY = "Your last reply was empty: continue the task, calling a tool or giving your answer.";
const CUT_OFF_BEFORE_ANSWER = "Your last reply was cut off at the output limit before any text or tool call: continue the task, more briefly, calling a tool or giving your answer.";
const CONTINUE = "Your reply was cut off at the output limit; continue from where it stopped, more briefly.";
const MAX_CONTINUATIONS = 2;
const NOT_AN_ANSWER = [EMPTY_REPLY, CUT_OFF_BEFORE_ANSWER, CONTINUE];
/** The notes after a reply left out of the history. One that is last when a run stops was never answered. */
export const AFTER_EMPTY = [EMPTY_REPLY, CUT_OFF_BEFORE_ANSWER];

/**
 * What the model is asked once the steps have run out mid-task (see AgentOptions.wrapUp). Its reply is a
 * report the loop asked for, not a finished answer: export.ts knows it by this request.
 */
export const WRAP_UP = "You have run out of steps. Don't call any tools: say what you changed, what you verified and how, and what is left undone.";

/** The budget notes' note before the last step whose tool calls run (a wrap-up may follow it, without tools). */
const LAST_STEP = "(Note from jig: your next reply is the last step whose tool calls run. Make sure your changes are saved and checked; don't start new exploration.)";

/**
 * The budget notes' note after a step's tool results: the steps used, and with a deadline the time left, once
 * half of either is used; before the last step, LAST_STEP instead; nothing after it, where no step follows.
 */
function budgetNote(step: number, maxSteps: number, { begun, deadline }: { begun: number; deadline?: number }): string | undefined {
  if (step >= maxSteps) return undefined;
  if (step === maxSteps - 1) return LAST_STEP;
  const now = Date.now();
  if (2 * step < maxSteps && (deadline === undefined || 2 * (now - begun) < deadline - begun)) return undefined;
  let time = "";
  if (deadline !== undefined) {
    // "9 of 30 minutes", or "45 seconds of 30 minutes".
    const [left, unit] = inUnits(deadline - now);
    const [all, allUnit] = inUnits(deadline - begun);
    time = `, with ${left}${unit === allUnit ? "" : ` ${unit}`} of ${all} ${allUnit} left`;
  }
  return `(Note from jig: you have used ${step} of your ${maxSteps} steps${time}.)`;
}

/** A time as the model is told it, rounded down: in minutes from 2 minutes up, else in seconds. */
function inUnits(ms: number): [number, string] {
  if (ms >= 120_000) return [Math.floor(ms / 60_000), "minutes"];
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [seconds, seconds === 1 ? "second" : "seconds"];
}

/** How many steps after a failed compaction the next one is tried. */
const COMPACT_AGAIN_AFTER = 3;

/**
 * How often a task's Stop hooks may send the model back. A check the model can't satisfy (a test it can't
 * fix, a broken command) would otherwise take every step left, each a model call and a run of the hooks.
 */
export const MAX_STOP_BLOCKS = 3;

/** What the model is told when the Stop hooks won't let the task end, with what they reported. */
function stopBlocked(reason: string): string {
  return `A Stop hook, a check this project runs before a task may end, says the task isn't done:

${reason}

Deal with what it reports, then finish.`;
}

/**
 * How many steps in a row with the same calls and the same results end a run ("loop"). Five, as milestone
 * 27 counted looping: nothing warns the model first, and waiting for something slow (a server starting)
 * can poll a few times with the same result.
 */
export const SAME_STEPS = 5;

/**
 * Compacts between steps. A new request from the user is kept out of the summary and stays after it,
 * so the model still gets the user's exact words; otherwise the task is mid-way and the model carries on.
 * The loop's note after a reply that wasn't an answer is no request: kept, it would point at a reply the
 * model can no longer see, so it goes into the summary too.
 */
async function compactConversation(conversation: Conversation, opts: AgentOptions, options: Pick<CompactOptions, "task" | "tooLong" | "signal">) {
  const last = conversation.messages.at(-1);
  const isRequest = last?.role === "user" && typeof last.content === "string" && !NOT_AN_ANSWER.includes(last.content);
  opts.ui.notice(`Compacting the conversation (${formatTokens(conversation.tokens)} tokens)…`);
  const compacted = await compact(conversation, opts.callModel, { ...options, keep: isRequest ? [last] : [], continueTask: !isRequest });
  if (!compacted) return undefined;
  const cut = compacted.cut ? ` (summarized with ${compacted.cut} tool result${compacted.cut === 1 ? "" : "s"} cut short, to fit)` : "";
  opts.ui.notice(`Compacted ${formatTokens(compacted.before)} tokens into about ${formatTokens(compacted.after)}${cut}.`);
  return compacted;
}

/**
 * One tool call, through each check in turn: it doesn't repeat an earlier call in the reply, the tool
 * exists and the request offered it, the run wasn't interrupted, the call wasn't cut off mid-input, the
 * input is valid, the hooks and then the permission policy allow it. Then it runs, its output is trimmed,
 * and the after-hooks have their say. A failed check becomes an error result that says what went wrong,
 * which the model can act on.
 */
async function handleToolCall(
  call: ToolUse,
  state: { cutOff: boolean; malformed?: string; offered?: string[]; repeats?: number },
  conversation: Conversation,
  opts: AgentOptions,
  usage: Usage,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const fail = (content: string): ToolResult => {
    opts.ui.toolResult(content, true, call.id);
    return { type: "tool_result", tool_use_id: call.id, content, is_error: true };
  };

  // The earlier call's result answers this one, whatever it was.
  if (state.repeats) {
    opts.count?.("call.repeat");
    opts.ui.toolCall(call.name, "", call.id);
    return fail(`Not run: identical to an earlier call in this reply (call ${state.repeats}).`);
  }
  const tool = opts.tools.find((t) => t.definition.name === call.name);
  // A tool the request didn't declare isn't the model's to call, even one jig has.
  const offered = state.offered ?? opts.tools.map((t) => t.definition.name);
  if (!tool || !offered.includes(call.name)) {
    opts.count?.("call.notOffered");
    opts.ui.toolCall(call.name, "", call.id);
    return fail(`${tool ? `Not run: ${call.name} isn't one of the tools offered for this step` : `Unknown tool "${call.name}"`}. Available: ${offered.join(", ")}.`);
  }
  if (signal?.aborted) {
    opts.ui.toolCall(call.name, "", call.id);
    return fail(`Not run: ${whyStopped(signal, "the user interrupted")}.`);
  }
  if (state.cutOff) {
    opts.count?.("call.cutOff");
    opts.ui.toolCall(call.name, "", call.id);
    return fail("Not run: your reply hit the output limit before this call was complete. Try again in smaller steps.");
  }
  // The model's input was streamed without server-side validation, so check it before anything runs.
  const problem = state.malformed !== undefined ? jsonProblem(state.malformed) : checkInput(tool, call.input);
  if (problem) {
    opts.count?.("call.invalid");
    opts.ui.toolCall(call.name, "(invalid input)", call.id);
    return fail(invalidInput(state.malformed ?? JSON.stringify(call.input), problem));
  }

  const input = call.input as ToolInput;
  opts.ui.toolCall(call.name, describe(tool, input), call.id);
  // The hooks and the permission check can throw too: a bug, or a path with a NUL byte, which a hook's
  // environment can't hold. The call then gets an error result, since an unanswered call would make every
  // later request invalid, and it doesn't run, since nothing has said it may.
  let checking = "the PreToolUse hooks";
  try {
    // Hooks first, as in Claude Code: no point asking the user about a call a hook would block anyway.
    // What a hook says can be a whole test log, so it is cut like a tool's output.
    const blocked = await opts.hooks?.before(call.name, input, signal);
    if (blocked) {
      opts.count?.("hook.blocked");
      return fail(`Blocked by a hook: ${truncate(blocked)}`);
    }
    if (signal?.aborted) return fail(`Not run: ${whyStopped(signal, "the user interrupted")}.`);
    checking = "the permission check";
    const refusal = await opts.authorize(tool, input);
    if (refusal) {
      opts.count?.("call.refused");
      return fail(refusal);
    }
    // The user can take longer to approve a call than --time-limit had left.
    if (signal?.aborted) return fail(`Not run: ${whyStopped(signal, "the user interrupted")}.`);
  } catch (err) {
    return fail(`Not run: ${checking} failed: ${errorMessage(err)}`);
  }
  let output: string;
  try {
    const pin = (key: string, text: string) => conversation.pin(key, text);
    // What the tool counts is counted once it has returned, here: from inside a tool (bash counts in a
    // child process's event handler), a counter that throws would leave the call unanswered.
    const counted: Mechanism[] = [];
    const count = (event: Mechanism) => void counted.push(event);
    const context = { cwd: opts.cwd, dirs: opts.dirs, hidden: opts.hidden, gitLocked: opts.gitLocked, checkWrites: opts.checkWrites, mayRun: opts.mayRun, tolerantEdits: opts.tolerantEdits, versions: conversation.versions, signal, sandbox: opts.sandbox, outputs: opts.outputs, pin, usage, count };
    const whole = await tool.run(input, context);
    for (const event of counted) opts.count?.(event);
    output = truncate(whole);
    if (output !== whole) opts.count?.("output.truncated");
  } catch (err) {
    return fail(errorMessage(err));
  }
  try {
    const feedback = await opts.hooks?.after(call.name, input, output, signal);
    if (feedback) {
      opts.count?.("hook.feedback");
      output = `${output.trimEnd()}\n\nA hook checked this result and reported:\n${truncate(feedback)}`;
    }
  } catch (err) {
    // The call has run, so its result stands; the user hears that the hooks couldn't check it.
    opts.ui.notice(`The PostToolUse hooks failed: ${errorMessage(err)}`);
  }
  opts.ui.toolResult(output, false, call.id);
  return { type: "tool_result", tool_use_id: call.id, content: output };
}

/**
 * What makes two calls the same: the tool and the input, its keys sorted (models don't always write them
 * in the same order), or the input as written when it wasn't valid JSON.
 */
function callKey(call: ToolUse, malformed?: string): string {
  const sorted = (_key: string, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value;
  return JSON.stringify([call.name, malformed ?? call.input], sorted);
}

/** A call as the terminal shows it. Only shown, so a tool that can't describe its input shows the input. */
function describe(tool: Tool, input: ToolInput): string {
  try {
    return tool.describe(input);
  } catch {
    return JSON.stringify(input);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How much of an invalid call's input goes back to the model: its start, and what came just before the error. */
const SHOWN_START = 2_000;
const SHOWN_BEFORE_ERROR = 400;

/**
 * An invalid call, as the model is told of it: what was wrong, and enough of what it wrote to see why. Not
 * all of it: a reply that runs until its output limit can leave a call of 100k characters, and in milestone
 * 27, sent back whole, such calls made a 32k server's conversations outgrow it.
 */
function invalidInput(raw: string, error: string): string {
  if (raw.length <= SHOWN_START) return JSON.stringify({ INVALID_JSON: raw, error });
  const at = Number(/in JSON at position (\d+)/.exec(error)?.[1] ?? 0);
  const before = at > SHOWN_START ? raw.slice(Math.max(SHOWN_START, at - SHOWN_BEFORE_ERROR), at) : "";
  const shown = `its first ${SHOWN_START} characters${before ? `, and the ${before.length} before the error` : ""}, of ${raw.length}`;
  return JSON.stringify({ INVALID_JSON: `${raw.slice(0, SHOWN_START)}…`, ...(before && { BEFORE_ERROR: `…${before}` }), error, shown });
}

/** Why streamed input isn't a tool's input, in the parser's words (they give the position). */
function jsonProblem(raw: string): string {
  try {
    JSON.parse(raw || "{}");
  } catch (err) {
    return `input is not valid JSON (${(err instanceof Error ? err.message : String(err)).slice(0, 200)})`;
  }
  return "input is not a JSON object";
}

/** Commands that run a project's tests, by the usual runners' names. */
const TEST_COMMAND = /\b(pytest|unittest|tox|npm (run )?test|yarn test|pnpm test|node --test|jest|vitest|mocha|go test|cargo test|make (check|test)|rspec|phpunit|dotnet test|ctest)\b/;

/** What the runners print when tests fail: unittest, pytest, node --test, jest and vitest, go test, cargo test. */
const TESTS_FAILED = /^FAILED \(|\b[1-9]\d* (failed|errors?)\b|^(#|ℹ) fail [1-9]|^--- FAIL|^FAIL\b|test result: FAILED/m;

/**
 * Whether a call ran the tests and they failed: a non-zero exit code, or the runner's own report, since
 * a pipe like `| tail -20`, which models add to most test runs, leaves the exit code tail's.
 */
export function failedTestRun(call: ToolUse, result: ToolResult): boolean {
  if (call.name !== "bash" || !TEST_COMMAND.test(String((call.input as ToolInput).command ?? ""))) return false;
  const content = typeof result.content === "string" ? result.content : "";
  return /Exit code: [1-9]\d*\s*$/.test(content) || TESTS_FAILED.test(content);
}

/**
 * Programs that only look at files, change them or wait, and the shell's words that come where a program
 * would (for, done, fi): a command made of nothing else ran nothing that could check the work (see
 * runsSomething). git is here too: diff, status and apply check nothing.
 */
const LOOKS_OR_CHANGES = new Set([
  ...["cat", "ls", "grep", "egrep", "rg", "head", "tail", "less", "more", "nl", "wc", "diff", "cmp", "find", "tree", "stat", "file", "du", "df"],
  ...["pwd", "cd", "echo", "printf", "sed", "awk", "sort", "uniq", "cut", "tr", "tee", "jq", "xxd", "od", "hexdump", "basename", "dirname"],
  ...["realpath", "readlink", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "ln", "patch", "git", "true", "false", "sleep", "which"],
  ...["test", "[", "[[", "export", "unset", "for", "done", "fi", "esac", "case"],
]);
/** Words a command's program can follow: the shell's own. */
const BEFORE_PROGRAM = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);

/**
 * Whether a bash command runs something: a program other than those that only look at files, change them or
 * wait (LOOKS_OR_CHANGES), in any of its commands, substitutions and pipes included. A heredoc's lines are a
 * file's content, and what is in quotes is an argument, so neither counts, but for a substitution in double
 * quotes (`echo "Result: $(python3 solve.py)"`), which runs. A program it can't tell (a variable, say)
 * counts as running something, so --finish-gate stays quiet.
 */
export function runsSomething(command: string): boolean {
  // `cat > solve.py << 'EOF'` writes solve.py, whatever its lines say, up to the line with the delimiter.
  const lines: string[] = [];
  let heredoc: string | undefined;
  for (const line of command.split("\n")) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    lines.push(line);
    heredoc = /(?<!<)<<(?!<)-?\s*["'\\]?(\w+)/.exec(line)?.[1];
  }
  // Each command of a list, a pipe or a substitution (but not 2>&1's &), by its first word that is no variable
  // assignment, redirection or keyword.
  return withoutQuotedText(lines.join("\n")).split(/&&|\|\||[;|\n()`]|(?<![<>])&(?!>)/).some((part) => {
    const words = part.trim().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!word || /^\w+=/.test(word) || BEFORE_PROGRAM.has(word)) continue;
      if (/^\d*[<>]/.test(word)) {
        if (/^\d*[<>]+&?$/.test(word)) i++; // `> out.txt`: the file comes next
        continue;
      }
      return !LOOKS_OR_CHANGES.has(basename(word));
    }
    return false;
  });
}

/**
 * A command with each quoted string made `''`, but for the substitutions in double quotes, which stay as they
 * are: `[ "$(./solve 3)" = "6" ]` becomes `[ ''$(./solve 3) = '' ]`.
 */
function withoutQuotedText(command: string): string {
  let out = "";
  // What the scanner is in, innermost last: double quotes ('"'), parentheses, a substitution's included
  // ("("), or a substitution in backquotes ("`").
  const within: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (within.at(-1) === '"') {
      // In double quotes all is text, but for a substitution (`$((` is arithmetic) and the closing quote.
      if (c === "\\") i++;
      else if (c === '"') within.pop();
      else if (c === "`" || (command.startsWith("$(", i) && command[i + 2] !== "(")) {
        within.push(c === "`" ? c : "(");
        out += c === "`" ? c : "$(";
        if (c === "$") i++;
      }
      continue;
    }
    if (c === "'") {
      // In single quotes nothing is special, up to the next.
      const end = command.indexOf("'", i + 1);
      i = end < 0 ? command.length : end;
      out += "''";
      continue;
    }
    if (c === '"') {
      within.push(c);
      out += "''";
      continue;
    }
    if (c === "\\") {
      out += command.slice(i, i + 2); // an escaped quote is no quote
      i++;
      continue;
    }
    if (c === "(") within.push(c);
    else if (c === ")" && within.at(-1) === "(") within.pop();
    else if (c === "`" && within.at(-1) === "`") within.pop();
    else if (c === "`") within.push(c);
    out += c;
  }
  return out;
}

/** What --finish-gate keeps of a task's tool calls, as they run (see follow). */
interface Trail {
  /** When the last command that ran something (see runsSomething) ended, as Date.now() gives it. */
  ran?: number;
  /** The paths write_file and edit_file changed since then, as the model gave them. */
  changed: string[];
  /** The last test run's command, if it failed (see failedTestRun). */
  failedTest?: string;
}

/** Adds a call that ended at `ended` to the trail. One that didn't run (an error result) adds nothing. */
function follow(trail: Trail, call: ToolUse, result: ToolResult, ended: number): void {
  if (result.is_error) return;
  const input = call.input as ToolInput;
  if (call.name === "write_file" || call.name === "edit_file") trail.changed.push(String(input.path));
  const command = String(input.command ?? "");
  if (call.name !== "bash" || !runsSomething(command)) return;
  trail.ran = ended;
  trail.changed = [];
  if (TEST_COMMAND.test(command)) trail.failedTest = failedTestRun(call, result) ? command : undefined;
}

/**
 * What --finish-gate tells the model, or undefined if its trail shows nothing unchecked. First, the files
 * changed after the last command that ran something, or with none run at all: those the file tools changed
 * since, and of the project's files the task changed (`changed`, by its snapshot), those still there that
 * were last modified after that command ended, which commands changed. Else the last test run, if it failed.
 */
function finishGap(trail: Trail, cwd: string, changed: string[] = []): string | undefined {
  // Named as the snapshot names them: relative to the project, if they are in it.
  const byTools = trail.changed.map((path) => {
    const abs = resolve(cwd, path);
    return isInside(cwd, abs) ? relative(cwd, abs) : abs;
  });
  const byCommands = changed.filter((path) => changedSince(join(cwd, path), trail.ran));
  const files = [...new Set([...byTools, ...byCommands])];
  if (files.length) {
    const [it, its] = files.length === 1 ? ["it", "its"] : ["them", "their"];
    const when = trail.ran === undefined ? "without running anything" : "after you last ran anything";
    return `you changed ${listed(files)} ${when}: run ${it}, or ${its} tests, before you finish.`;
  }
  if (trail.failedTest === undefined) return undefined;
  const command = trail.failedTest.trim().replace(/\s+/g, " ");
  return `your last test run failed (\`${command.length > 100 ? `${command.slice(0, 100)}…` : command}\`): fix what it reports, or say why it can't pass, before you finish.`;
}

/** Whether a file is there and was last modified after `time`, or at all if there is no time. */
function changedSince(path: string, time: number | undefined): boolean {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return !!stat && (time === undefined || stat.mtimeMs > time);
  } catch {
    return false; // ENOTDIR: a file has replaced its directory
  }
}

/** "a", "a and b", "a, b, c and d", or the first three and how many more. */
function listed(names: string[]): string {
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} other files`] : names;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** The text of a message: a string, or its text blocks joined. */
function textOf(message?: Anthropic.Beta.BetaMessageParam): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function replyText(reply: Message): string {
  return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Adds one run's token counts to another's (a review's to its task's). */
export function addUsages(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.cacheWrite += usage.cacheWrite;
  total.cacheRead += usage.cacheRead;
  total.output += usage.output;
}

/** Adds one reply's token counts to a run's totals. */
export function addUsage(total: Usage, usage: Anthropic.Beta.BetaUsage): void {
  total.input += usage.input_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.output += usage.output_tokens;
}

/** Tokens in a request (cached or not) plus its reply: the size of the conversation after that step. */
export function contextSize(usage: Anthropic.Beta.BetaUsage): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens;
}

/** 950 → "950", 12_345 → "12.3k". */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
