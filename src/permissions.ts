import { resolve } from "node:path";
import type { Tool, ToolInput } from "./tools/index.ts";
import { parseCommand } from "./tools/shell.ts";
import { isInside } from "./tools/util.ts";

/**
 * How much jig may do without asking:
 *   plan   look only: file changes and commands that change things are refused, not asked about
 *   ask    every file change and every command asks first
 *   edits  file changes run without asking (the file tools only work inside the project); commands ask,
 *          unless the sandbox contains them
 *   auto   everything runs without asking
 * In every mode, looking never asks (the read tools, and commands that only read inside the project),
 * and the settings' deny rules are always refused.
 */
export const MODES = ["plan", "ask", "edits", "auto"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_HELP: Record<Mode, string> = {
  plan: "look around and plan; refuse every change",
  ask: "ask before every file change and command",
  edits: "change files in the project freely; ask before commands the sandbox doesn't contain",
  auto: "never ask",
};

/** Run the call, ask the user first, or refuse it (the reason goes to the model). */
export type Decision = "allow" | "ask" | { refuse: string };

export interface PolicyOptions {
  /** Commands that run without asking, matched by their first words. */
  allow?: string[];
  /** Commands that are always refused. */
  deny?: string[];
  /** Commands run in a sandbox that keeps them inside the project and off the network. */
  contained?: boolean;
  /** Directories outside the project that count as part of it (--add-dir). */
  dirs?: string[];
}

// Programs that only print: they don't change files or start other programs, whatever their arguments.
const READERS = new Set(["cat", "cut", "diff", "du", "echo", "grep", "head", "ls", "nl", "pwd", "stat", "tail", "tr", "wc", "which"]);
// These only read as long as they don't get an option that writes files or runs programs.
const GIT_READERS = new Set(["blame", "diff", "log", "ls-files", "rev-parse", "show", "status"]);
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/;

/**
 * The permission policy for a session: decides each tool call (run it, ask the user, or refuse) by the
 * mode, the settings' allow and deny rules, whether the sandbox contains commands, and the "always"
 * answers the user has given so far.
 */
export class Permissions {
  mode: Mode;
  private readonly root: string;
  private readonly dirs: string[];
  private readonly allowRules: string[][];
  private readonly denyRules: string[];
  private readonly contained: boolean;
  /** Programs the user chose to always allow for this session, like "python3". */
  private readonly programs = new Set<string>();
  /** External tools (MCP) the user chose to always allow for this session. */
  private readonly externalTools = new Set<string>();

  constructor(mode: Mode, root: string, { allow = [], deny = [], contained = false, dirs = [] }: PolicyOptions = {}) {
    this.mode = mode;
    this.root = root;
    this.dirs = dirs;
    this.allowRules = allow.map((rule) => rule.split(/\s+/));
    this.denyRules = deny;
    this.contained = contained;
  }

  /** Whether a call runs, asks first, or is refused (and why). */
  decide(tool: Tool, input: ToolInput): Decision {
    const name = tool.definition.name;
    if (this.denyRules.includes(name)) return { refuse: `Refused: the ${name} tool is denied in jig's settings.` };
    const command = tool.kind === "run" ? String(input.command) : "";
    const rule = command && this.denyRules.find((r) => matchesDenyRule(command, r));
    if (rule) return { refuse: `Refused: the command matches the deny rule "${rule}" in jig's settings. Don't try to get around it.` };
    // A proposal asks the user itself, and changes nothing until they agree.
    if (tool.kind === "read" || tool.kind === "propose") return "allow";
    if (tool.kind === "external") return this.decideExternal(tool.definition.name);
    const commands = command ? parseCommand(command) : null;
    if (this.mode === "plan") {
      if (commands?.every((argv) => this.readsOnly(argv))) return "allow";
      return { refuse: "Refused: plan mode is on, so nothing may be changed. Investigate, then describe the changes you would make." };
    }
    if (this.mode === "auto") return "allow";
    if (tool.kind === "edit") return this.mode === "edits" ? "allow" : "ask";
    if (commands?.every((argv) => this.readsOnly(argv) || this.isApproved(argv) || this.allowedByRule(argv))) return "allow";
    return this.mode === "edits" && this.contained ? "allow" : "ask";
  }

  /**
   * Tools from MCP servers. They act outside the sandbox (on GitHub, in a browser, in a database), so
   * they ask unless the settings allow them by name, and plan mode refuses them unless they are marked
   * read-only (then their kind is "read"). Deny rules name them too, like "mcp__github__merge_pull_request".
   */
  private decideExternal(name: string): Decision {
    if (this.mode === "plan") return { refuse: "Refused: plan mode is on, so nothing may be changed. Describe what you would do instead." };
    if (this.mode === "auto" || this.externalTools.has(name) || this.allowRules.some((rule) => rule.join(" ") === name)) return "allow";
    return "ask";
  }

  /** What answering "always" would allow from now on, or null if this call can't be generalized. */
  alwaysLabel(tool: Tool, input: ToolInput): string | null {
    if (tool.kind === "edit") return "file changes";
    if (tool.kind === "external") return `the ${tool.definition.name} tool`;
    const programs = this.newPrograms(input);
    return programs.length ? `${programs.map((p) => `\`${p}\``).join(", ")} commands in this project` : null;
  }

  /** Remembers an "always" answer for the rest of the session. */
  allowAlways(tool: Tool, input: ToolInput): void {
    if (tool.kind === "external") this.externalTools.add(tool.definition.name);
    if (tool.kind === "edit" && this.mode === "ask") this.mode = "edits";
    for (const program of this.newPrograms(input)) this.programs.add(program);
  }

  private newPrograms(input: ToolInput): string[] {
    const commands = typeof input.command === "string" ? parseCommand(input.command) : null;
    if (!commands) return [];
    const programs = commands.filter((argv) => !this.readsOnly(argv)).map((argv) => argv[0]);
    return [...new Set(programs)].filter((program) => !this.programs.has(program));
  }

  private isApproved([program, ...args]: string[]): boolean {
    return this.programs.has(program) && this.stayInside(args);
  }

  private allowedByRule(argv: string[]): boolean {
    return this.stayInside(argv.slice(1)) && this.allowRules.some((rule) => rule.every((word, i) => argv[i] === word));
  }

  private readsOnly([program, ...args]: string[]): boolean {
    if (!this.stayInside(args)) return false;
    if (READERS.has(program)) return true;
    if (program === "find") return !args.some((arg) => FIND_ACTIONS.test(arg));
    if (program === "git") return GIT_READERS.has(args[0] ?? "") && !args.some((arg) => arg.startsWith("--output"));
    return false;
  }

  /**
   * False if any argument looks like a path outside the project (and the added directories): an absolute
   * path elsewhere, anything in ~, or climbing out with "..".
   */
  private stayInside(args: string[]): boolean {
    return args.every((arg) => {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
      if (value.startsWith("~")) return false;
      if (!value.startsWith("/") && !value.split("/").includes("..")) return true;
      const abs = resolve(this.root, value);
      return [this.root, ...this.dirs].some((dir) => isInside(dir, abs));
    });
  }
}

/**
 * Whether a command contains a deny rule's words, in order, within one simple command, looking inside
 * quotes and substitutions too. So "git push" also matches `git -C repo push`, `cd x && git push` and
 * `bash -c "git push"`; the price is false alarms like `git log --grep push`. Deny rules can't catch
 * every disguise (`g\it push`), so they are a guardrail; the sandbox is what actually contains commands.
 */
export function matchesDenyRule(command: string, rule: string): boolean {
  const words = rule.split(/\s+/);
  for (const part of command.split(/&&|\|\||[;|&\n()`]|\$\(/)) {
    const tokens = part.split(/\s+/).map((token) => token.replace(/^["'$]+|["']+$/g, "")).filter(Boolean);
    let next = 0; // how many of the rule's words have been seen, in order
    for (const token of tokens) {
      if (token === words[next]) next++;
      if (next === words.length) return true;
    }
  }
  return false;
}
