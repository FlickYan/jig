import { resolve } from "node:path";
import type { Tool, ToolInput } from "./tools/index.ts";
import { parseCommand } from "./tools/shell.ts";
import { isInside } from "./tools/util.ts";

/**
 * How much jig may do without asking:
 *   ask    every file change and every command asks first
 *   edits  file changes run without asking (the file tools only work inside the project); commands ask
 *   auto   everything runs without asking
 * In every mode, looking never asks: the read tools, and commands that only read inside the project.
 */
export const MODES = ["ask", "edits", "auto"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_HELP: Record<Mode, string> = {
  ask: "ask before every file change and command",
  edits: "change files in the project freely, ask before commands",
  auto: "never ask",
};

// Programs that only print: they don't change files or start other programs, whatever their arguments.
const READERS = new Set(["cat", "cut", "diff", "du", "echo", "grep", "head", "ls", "nl", "pwd", "stat", "tail", "tr", "wc", "which"]);
// These only read as long as they don't get an option that writes files or runs programs.
const GIT_READERS = new Set(["blame", "diff", "log", "ls-files", "rev-parse", "show", "status"]);
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/;

export class Permissions {
  mode: Mode;
  private readonly root: string;
  /** Programs the user chose to always allow for this session, like "python3". */
  private readonly programs = new Set<string>();

  constructor(mode: Mode, root: string) {
    this.mode = mode;
    this.root = root;
  }

  /** Whether a tool call can run without asking the user first. */
  allows(tool: Tool, input: ToolInput): boolean {
    if (tool.kind === "read" || this.mode === "auto") return true;
    if (tool.kind === "edit") return this.mode === "edits";
    const commands = parseCommand(String(input.command));
    return commands !== null && commands.every((argv) => this.readsOnly(argv) || this.isApproved(argv));
  }

  /** What answering "always" would allow from now on, or null if this call can't be generalized. */
  alwaysLabel(tool: Tool, input: ToolInput): string | null {
    if (tool.kind === "edit") return "file changes";
    const programs = this.newPrograms(input);
    return programs.length ? `${programs.map((p) => `\`${p}\``).join(", ")} commands in this project` : null;
  }

  /** Remembers an "always" answer for the rest of the session. */
  allowAlways(tool: Tool, input: ToolInput): void {
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

  private readsOnly([program, ...args]: string[]): boolean {
    if (!this.stayInside(args)) return false;
    if (READERS.has(program)) return true;
    if (program === "find") return !args.some((arg) => FIND_ACTIONS.test(arg));
    if (program === "git") return GIT_READERS.has(args[0] ?? "") && !args.some((arg) => arg.startsWith("--output"));
    return false;
  }

  /** False if any argument looks like a path outside the project: absolute, ~, or climbing out with "..". */
  private stayInside(args: string[]): boolean {
    return args.every((arg) => {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
      if (value.startsWith("/") || value.startsWith("~")) return false;
      return !value.split("/").includes("..") || isInside(this.root, resolve(this.root, value));
    });
  }
}
