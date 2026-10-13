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
 * Totals for a session in a JSON file (--stats), for scripts and evaluation harnesses: model calls,
 * tokens (subagents included) and tool calls. It is rewritten after every model call, so a run that
 * is killed, at a benchmark's time limit say, still leaves its numbers behind.
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
