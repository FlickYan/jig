import { writeFileSync } from "node:fs";
import { addUsage, type RunResult, type Usage } from "./agent.ts";
import type { CallModel } from "./model.ts";

/** Calls made by another model than the session's: the one that took over (--escalate), or the reviewer. */
export interface Share {
  kind: "escalated" | "reviewed";
  model: string;
}

interface ShareTotals {
  model: string;
  modelCalls: number;
  usage: Usage;
}

/**
 * The mechanisms --stats counts, each time one fires: what jig did besides calling the model and running
 * the tools. A change to one of them can then be seen to run at all; in milestone 28, two candidates'
 * changes ran in none of their attempts, which only reading the sessions showed.
 */
export type Mechanism =
  // The model's calls (model.ts): a request the SDK sent again (a rate limit, an overload, a server error,
  // a timeout), and a reply jig asked for again because it broke off, went quiet, or its tool input wasn't JSON.
  | "retry.api"
  | "retry.brokeOff"
  | "retry.quiet"
  | "retry.malformed"
  // The loop (agent.ts): a summary replaced the conversation; past --compact-at one failed, so the task went
  // on as it was; the API said the conversation was too long, so it was compacted and the call made again.
  | "compaction"
  | "compaction.failed"
  | "compaction.tooLong"
  // A reply with no text or tool call, one cut off at the output limit (the model was asked to go on, or to
  // continue), and one a safety classifier declined.
  | "reply.empty"
  | "reply.continued"
  | "reply.refused"
  // Tool calls that didn't run as asked: a repeat of an earlier call in the reply, a tool the request didn't
  // offer, a call cut off at the output limit, invalid input, and one the permission check refused (plan
  // mode, a deny rule, a subagent's call that would need asking, the user's no), which includes those the
  // CLI counts as needing an approval nobody was there to give; a PreToolUse hook's block, a PostToolUse
  // hook's report on a result, and output cut to its start and end to fit.
  | "call.repeat"
  | "call.notOffered"
  | "call.cutOff"
  | "call.invalid"
  | "call.refused"
  | "call.unapproved"
  | "hook.blocked"
  | "hook.feedback"
  | "output.truncated"
  // A Stop hook that sent the model back to work, and one that still would after MAX_STOP_BLOCKS times,
  // so the task ended anyway.
  | "hook.stopBlocked"
  | "hook.stopCapped"
  // --check's request, --reviewer's review and the problems it sent back (either skipped, too close to
  // --time-limit), --escalate's handover, the stop for repeating the same calls, and the wrap-up at --max-steps.
  | "check"
  | "check.skipped"
  | "review"
  | "review.skipped"
  | "review.problems"
  | "escalated"
  | "loop"
  | "wrapUp";

/**
 * Totals for a session in a JSON file (--stats), for scripts and evaluation harnesses: model calls,
 * tokens (subagents included), tool calls, and how often each Mechanism fired. It is rewritten after
 * every model call and every mechanism that fires, so a run that is killed, at a benchmark's time limit
 * say, still leaves its numbers behind.
 */
export class Stats {
  private readonly path: string;
  private readonly started = Date.now();
  private readonly data: {
    model: string;
    /** Why the last task ended (as in RunResult), "error" if it failed, or null while it runs. */
    stop: RunResult["stop"] | "error" | null;
    error?: string;
    steps: number;
    modelCalls: number;
    subagentModelCalls: number;
    usage: Usage;
    /** With --escalate, once a model took over: its calls and tokens, which the totals include. */
    escalated?: ShareTotals;
    /** With --reviewer: the reviewer's calls and tokens, which the totals include. */
    reviewed?: ShareTotals;
    toolCalls: Record<string, number>;
    /** How often each mechanism fired, by name, subagents' and the reviewer's included; those that didn't are left out. */
    events: Partial<Record<Mechanism, number>>;
    seconds: number;
  };

  constructor(path: string, model: string) {
    this.path = path;
    this.data = {
      model,
      stop: null,
      steps: 0,
      modelCalls: 0,
      subagentModelCalls: 0,
      usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      toolCalls: {},
      events: {},
      seconds: 0,
    };
    this.write();
  }

  /** The same model, with every call it makes counted; `share` says whose calls they are, if not the model's. */
  meter(callModel: CallModel, { subagent = false, share }: { subagent?: boolean; share?: Share } = {}): CallModel {
    return async (messages, signal, options) => {
      const turn = await callModel(messages, signal, options);
      if (subagent) this.data.subagentModelCalls++;
      else this.data.modelCalls++;
      addUsage(this.data.usage, turn.message.usage);
      if (share) {
        const totals = (this.data[share.kind] ??= { model: share.model, modelCalls: 0, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } });
        totals.modelCalls++;
        addUsage(totals.usage, turn.message.usage);
      }
      this.write();
      return turn;
    };
  }

  toolCall(name: string): void {
    this.data.toolCalls[name] = (this.data.toolCalls[name] ?? 0) + 1;
  }

  /** Written at once: a run killed while the API is asked again, say, still shows that it was. */
  count(event: Mechanism): void {
    this.data.events[event] = (this.data.events[event] ?? 0) + 1;
    this.write();
  }

  finish(result: RunResult): void {
    this.data.stop = result.stop;
    this.data.steps += result.steps;
    this.write();
  }

  failed(message: string): void {
    this.data.stop = "error";
    this.data.error = message;
    this.write();
  }

  private write(): void {
    this.data.seconds = Math.round((Date.now() - this.started) / 100) / 10;
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}
