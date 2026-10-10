import type Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "../agent.ts";
import { bashOnItsOwn, bashTool } from "./bash.ts";
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
  /** Directories outside the project the file tools may use too (--add-dir). */
  dirs?: string[];
  /** Keeps text (a skill's instructions, say) in the conversation even through compaction. */
  pin?(key: string, text: string): void;
  /** The current task's token counts, for tools that call the model themselves (subagents). */
  usage?: Usage;
}

export type ToolInput = Record<string, unknown>;

export interface Tool {
  /** Name, description and input schema, sent to the model as-is. */
  definition: Anthropic.Beta.BetaTool;
  /**
   * What the tool can do, which decides whether it needs approval: look, change files in the project,
   * run commands, act outside the sandbox's reach (an MCP server's tools), or propose a change to jig itself
   * (a memory, a skill), which the tool puts to the user on its own.
   */
  kind: "read" | "edit" | "run" | "external" | "propose";
  /** What the terminal shows for a call: the first line goes next to the tool name, the rest below it. */
  describe(input: ToolInput): string;
  /** Returns the text the model sees. To report a failure, throw an Error: its message goes to the model. */
  run(input: ToolInput, ctx: ToolContext): Promise<string>;
}

export const TOOLS: Tool[] = [readTool, grepTool, globTool, writeTool, editTool, bashTool];

/** What --tools can name: jig's own tools, and the subagent tool, which the CLI builds. */
export const TOOL_NAMES = [...TOOLS.map((tool) => tool.definition.name), "subagent"];

/** The tools in a --tools list ("bash,read_file"), checked against TOOL_NAMES. An empty list means none. */
export function parseToolList(list: string): string[] {
  const names = list.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.find((name) => !TOOL_NAMES.includes(name));
  if (unknown) throw new Error(`--tools: there is no tool "${unknown}". jig's tools are ${TOOL_NAMES.join(", ")}.`);
  return names;
}

/** jig's own tools, or only the named ones. Without grep, glob and read_file, bash stops recommending them. */
export function selectTools(names?: string[]): Tool[] {
  if (!names) return TOOLS;
  const searching = ["grep", "glob", "read_file"].every((name) => names.includes(name));
  return TOOLS.filter((tool) => names.includes(tool.definition.name)).map((tool) => (tool === bashTool && !searching ? bashOnItsOwn : tool));
}

/** Tool output longer than this (~10k tokens) is cut from the middle before the model sees it. */
export const MAX_OUTPUT_CHARS = 40_000;

/** Keeps the head and the tail: errors and test summaries tend to be at the end. */
export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - 2 * half} characters truncated ...]\n\n${text.slice(-half)}`;
}

/**
 * Checks a tool call's input against the tool's schema: required parameters, the type of each one,
 * enums, and unknown parameters where the schema forbids them. That covers jig's own flat schemas
 * completely; an MCP server's nested ones are only checked at the top, and the server checks the rest.
 * Returns what is wrong, or null if the input is valid.
 */
export function checkInput(tool: Tool, input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be a JSON object";
  const schema = tool.definition.input_schema;
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  for (const key of schema.required ?? []) {
    if (!(key in input)) return `missing required parameter "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property) {
      if (schema.additionalProperties === false) return `unknown parameter "${key}"`;
      continue;
    }
    if (property.type && !hasType(value, property.type)) {
      return `parameter "${key}" must be ${property.type === "integer" || property.type === "array" || property.type === "object" ? "an" : "a"} ${property.type}`;
    }
    if (property.enum && !property.enum.includes(value)) {
      return `parameter "${key}" must be one of: ${property.enum.map((v) => JSON.stringify(v)).join(", ")}`;
    }
  }
  return null;
}

function hasType(value: unknown, type: string): boolean {
  if (type === "integer") return Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "null") return value === null;
  return ["string", "number", "boolean"].includes(type) ? typeof value === type : true;
}
