import type Anthropic from "@anthropic-ai/sdk";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import type { Sandbox } from "../sandbox.ts";
import type { FileVersions } from "./util.ts";
import { writeTool } from "./write.ts";

export interface ToolContext {
  /** Project root. Relative paths resolve against it, and the file tools refuse to leave it. */
  cwd: string;
  /** What the model has read, so write_file can refuse to overwrite a file it hasn't seen as it is now. */
  versions: FileVersions;
  /** Aborted when the user presses Ctrl+C. */
  signal?: AbortSignal;
  /** Where commands run, if not directly on the machine. */
  sandbox?: Sandbox;
}

export type ToolInput = Record<string, unknown>;

export interface Tool {
  /** Name, description and input schema, sent to the model as-is. */
  definition: Anthropic.Beta.BetaTool;
  /** What the tool can do, which decides whether it needs approval: look, change files, or run commands. */
  kind: "read" | "edit" | "run";
  /** What the terminal shows for a call: the first line goes next to the tool name, the rest below it. */
  describe(input: ToolInput): string;
  /** Returns the text the model sees. To report a failure, throw an Error: its message goes to the model. */
  run(input: ToolInput, ctx: ToolContext): Promise<string>;
}

export const TOOLS: Tool[] = [readTool, grepTool, globTool, writeTool, editTool, bashTool];

/** Tool output longer than this (~10k tokens) is cut from the middle before the model sees it. */
export const MAX_OUTPUT_CHARS = 40_000;

/** Keeps the head and the tail: errors and test summaries tend to be at the end. */
export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - 2 * half} characters truncated ...]\n\n${text.slice(-half)}`;
}

/**
 * Checks a tool call's input against the tool's schema. Our schemas are flat objects of strings,
 * integers and booleans, so this covers them completely. Returns what is wrong, or null if it is valid.
 */
export function checkInput(tool: Tool, input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be a JSON object";
  const schema = tool.definition.input_schema;
  const properties = (schema.properties ?? {}) as Record<string, { type: string }>;
  for (const key of schema.required ?? []) {
    if (!(key in input)) return `missing required parameter "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const expected = properties[key]?.type;
    if (!expected) return `unknown parameter "${key}"`;
    const ok = expected === "integer" ? Number.isInteger(value) : typeof value === expected;
    if (!ok) return `parameter "${key}" must be ${expected === "integer" ? "an integer" : `a ${expected}`}`;
  }
  return null;
}
