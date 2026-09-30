#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAgent, type AgentOptions, type RunResult } from "./agent.ts";
import { createModel, EFFORTS, type Effort } from "./model.ts";
import { systemPrompt } from "./prompt.ts";
import { TOOLS, type Tool } from "./tools/index.ts";
import * as ui from "./ui.ts";

const HELP = `Usage: jig [options] [task]

Runs one task, or starts an interactive session if no task is given.

Options:
  -m, --model <id>      deepseek-flash (default), deepseek-v4-pro, or a Claude model like claude-opus-5-5
  -e, --effort <level>  ${EFFORTS.join(" | ")} (default: the model's own; DeepSeek takes low | high | max)
  -y, --yes             run every tool call without asking first
  -C, --cwd <dir>       project directory (default: the current directory)
      --max-steps <n>   most model calls per task (default: 50)
  -h, --help            show this help

In a session, /reset starts a new conversation and /exit quits.
Ctrl+C stops the current task (press it again to force quit).`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m", default: "deepseek-flash" },
      effort: { type: "string", short: "e" },
      yes: { type: "boolean", short: "y", default: false },
      cwd: { type: "string", short: "C", default: "." },
      "max-steps": { type: "string", default: "50" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const effort = values.effort as Effort | undefined;
  if (effort && !EFFORTS.includes(effort)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}`);
  const maxSteps = Number(values["max-steps"]);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("--max-steps must be a positive integer");

  const cwd = resolve(values.cwd);
  const messages: Anthropic.Beta.BetaMessageParam[] = []; // the conversation, kept across tasks in a session
  let alwaysAllow = values.yes;
  let task: AbortController | undefined; // the running task, so Ctrl+C can stop it

  async function approve(tool: Tool): Promise<boolean> {
    if (alwaysAllow) return true;
    if (!process.stdin.isTTY) {
      ui.notice("No terminal to ask for permission, so the call was declined. Use --yes to allow tool calls.");
      return false;
    }
    const answer = await ui.ask(`  Allow ${tool.definition.name}? [y]es / [n]o / [a]lways: `);
    if (answer === null) task?.abort(); // Ctrl+C at the prompt stops the whole task
    const choice = answer?.trim().toLowerCase() ?? "";
    if (choice.startsWith("a")) alwaysAllow = true;
    return choice.startsWith("y") || choice.startsWith("a");
  }

  const agent: AgentOptions = {
    callModel: createModel({ model: values.model, effort, system: systemPrompt(cwd), tools: TOOLS }),
    tools: TOOLS,
    cwd,
    maxSteps,
    approve,
    ui: ui.terminalUI,
  };

  async function runTask(text: string): Promise<boolean> {
    messages.push({ role: "user", content: text });
    const controller = (task = new AbortController());
    const onSigint = () => {
      if (controller.signal.aborted) process.exit(130); // second Ctrl+C: give up waiting
      ui.interrupted();
      controller.abort();
    };
    process.on("SIGINT", onSigint);
    const started = Date.now();
    try {
      report(await runAgent(messages, agent, controller.signal), Date.now() - started, maxSteps);
      return true;
    } catch (err) {
      ui.error(describeError(err));
      return false;
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  if (positionals.length > 0) {
    if (!(await runTask(positionals.join(" ")))) process.exitCode = 1;
    return;
  }

  ui.println(`${ui.bold("jig")} ${ui.dim(`· ${values.model} · effort ${effort ?? "default"} · ${cwd}`)}`);
  ui.println(ui.dim("Type a task and press Enter. /reset starts a new conversation, /exit quits."));
  for (;;) {
    ui.println();
    const line = await ui.ask(ui.bold("> "));
    if (line === null || line.trim() === "/exit") break;
    if (line.trim() === "/reset") {
      messages.length = 0;
      ui.notice("Started a new conversation.");
    } else if (line.trim()) {
      await runTask(line);
    }
  }
}

function report(result: RunResult, ms: number, maxSteps: number): void {
  const notes: Partial<Record<RunResult["stop"], string>> = {
    end_turn: "",
    max_steps: `Stopped after ${maxSteps} steps (raise the limit with --max-steps).`,
    max_tokens: "The reply was cut off at the output limit.",
    model_context_window_exceeded: "The conversation no longer fits in the context window. Use /reset to start over.",
    refusal: "The model declined this request.",
    interrupted: "Interrupted.",
  };
  const note = notes[result.stop] ?? `Stopped (${result.stop}).`;
  if (note) ui.notice(note);
  const { input, cacheWrite, cacheRead, output } = result.usage;
  const tokensIn = input + cacheWrite + cacheRead;
  ui.println(
    ui.dim(
      `${result.steps} step${result.steps === 1 ? "" : "s"} · ${k(tokensIn)} tokens in (${k(cacheRead)} from cache)` +
        ` · ${k(output)} out · ${(ms / 1000).toFixed(1)}s`,
    ),
  );
}

function k(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Authentication failed: check DEEPSEEK_API_KEY (DeepSeek models) or ANTHROPIC_API_KEY (Claude models).";
  }
  if (err instanceof Anthropic.APIError) return `API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

main().catch((err: unknown) => {
  ui.error(describeError(err));
  process.exitCode = 1;
});
