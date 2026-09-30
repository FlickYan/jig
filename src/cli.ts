#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAgent, type AgentOptions, type RunResult } from "./agent.ts";
import { createModel, EFFORTS, type Effort } from "./model.ts";
import { MODE_HELP, MODES, Permissions, type Mode } from "./permissions.ts";
import { systemPrompt } from "./prompt.ts";
import { TOOLS, type Tool, type ToolInput } from "./tools/index.ts";
import { FileVersions } from "./tools/util.ts";
import * as ui from "./ui.ts";

const HELP = `Usage: jig [options] [task]

Runs one task, or starts an interactive session if no task is given.

Options:
  -m, --model <id>      deepseek-flash (default), deepseek-v4-pro, or a Claude model like claude-opus-5-5
  -e, --effort <level>  ${EFFORTS.join(" | ")} (default: the model's own; DeepSeek takes low | high | max)
      --mode <mode>     when to ask before a tool call (default: edits)
${MODES.map((mode) => `                          ${mode.padEnd(6)} ${MODE_HELP[mode]}`).join("\n")}
  -y, --yes             same as --mode auto
      --hide-thinking   don't print the model's thinking (/thinking toggles it in a session)
  -C, --cwd <dir>       project directory (default: the current directory)
      --max-steps <n>   most model calls per task (default: 50)
  -h, --help            show this help

Reading files, and read-only commands (ls, cat, grep, git status, ...) inside the project, never ask.
Ctrl+C stops the current task (press it again to force quit).`;

const COMMANDS = `  /mode [ask|edits|auto]  show or change when jig asks before a tool call
  /thinking               show or hide the model's thinking
  /reset                  start a new conversation
  /exit                   quit (Ctrl+D works too)`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m", default: "deepseek-flash" },
      effort: { type: "string", short: "e" },
      mode: { type: "string", default: "edits" },
      yes: { type: "boolean", short: "y", default: false },
      "hide-thinking": { type: "boolean", default: false },
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
  const mode = (values.yes ? "auto" : values.mode) as Mode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  const maxSteps = Number(values["max-steps"]);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("--max-steps must be a positive integer");
  ui.setThinkingVisible(!values["hide-thinking"]);

  const cwd = resolve(values.cwd);
  const permissions = new Permissions(mode, cwd);
  const messages: Anthropic.Beta.BetaMessageParam[] = []; // the conversation, kept across tasks in a session
  let task: AbortController | undefined; // the running task, so Ctrl+C can stop it

  async function approve(tool: Tool, input: ToolInput): Promise<boolean> {
    if (permissions.allows(tool, input)) return true;
    if (!process.stdin.isTTY) {
      ui.notice("No terminal to ask for permission, so the call was declined. Use --yes to allow tool calls.");
      return false;
    }
    const always = permissions.alwaysLabel(tool, input);
    const answer = await ui.ask(`  Allow? [y]es / [n]o${always ? ` / [a]lways allow ${always}` : ""}: `);
    if (answer === null) task?.abort(); // Ctrl+C at the prompt stops the whole task
    const choice = answer?.trim().toLowerCase() ?? "";
    if (always && choice.startsWith("a")) {
      permissions.allowAlways(tool, input);
      return true;
    }
    return choice.startsWith("y");
  }

  const agent: AgentOptions = {
    callModel: createModel({ model: values.model, effort, system: systemPrompt(cwd), tools: TOOLS }),
    tools: TOOLS,
    cwd,
    maxSteps,
    versions: new FileVersions(),
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

  /** Runs a slash command. Returns false to quit. */
  function command(line: string): boolean {
    const [name, arg] = line.split(/\s+/);
    if (name === "/exit") return false;
    if (name === "/help") {
      ui.println(COMMANDS);
    } else if (name === "/reset") {
      messages.length = 0;
      agent.versions = new FileVersions();
      ui.notice("Started a new conversation.");
    } else if (name === "/thinking") {
      ui.setThinkingVisible(!ui.thinkingVisible());
      ui.notice(`Thinking is now ${ui.thinkingVisible() ? "shown" : "hidden"}.`);
    } else if (name === "/mode" && arg && !MODES.includes(arg as Mode)) {
      ui.notice(`Unknown mode "${arg}". Choose one of: ${MODES.join(", ")}.`);
    } else if (name === "/mode") {
      if (arg) permissions.mode = arg as Mode;
      ui.notice(`Mode: ${permissions.mode} (${MODE_HELP[permissions.mode]}).`);
    } else {
      ui.notice(`Unknown command ${name}. Type /help to see the commands.`);
    }
    return true;
  }

  if (positionals.length > 0) {
    if (!(await runTask(positionals.join(" ")))) process.exitCode = 1;
    return;
  }

  ui.println(`${ui.bold("jig")} ${ui.dim(`· ${values.model} · effort ${effort ?? "default"} · mode ${mode} · ${cwd}`)}`);
  ui.println(ui.dim("Type a task and press Enter. /help shows the commands."));
  for (;;) {
    ui.println();
    const line = await ui.ask(ui.bold("> "));
    if (line === null) break;
    const input = line.trim();
    if (input.startsWith("/")) {
      if (!command(input)) break;
    } else if (input) {
      await runTask(input);
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
  // The benchmark runner (bench/run.ts) reads this line, so keep its format.
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
