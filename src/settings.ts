// Settings, the user's (~/.jig/settings.json) and a project's (.jig/settings.json): which commands run
// without asking and which never run, the sandbox and the network, hooks and MCP servers. A project's
// settings could run programs, so apart from its deny rules they apply only once the user trusts the file.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { jigHome } from "./paths.ts";

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** A command the settings run before or after tool calls, or before a task ends (see hooks.ts). */
export interface Hook {
  event: HookEvent;
  /**
   * Tool names it applies to, as a regular expression like "edit_file|write_file" (default, or "*": all).
   * A Stop hook has no tool, so it has no use for one.
   */
  matcher?: string;
  /** Shell command; gets the tool call (or, for Stop, the task and the answer) as JSON on stdin. */
  command: string;
}

/**
 * A hook's matcher as a regular expression for whole tool names. "*" means every tool, as in Claude Code,
 * whose settings people copy: as a regular expression it is invalid, and threw on every tool call.
 */
export function hookMatcher(matcher?: string): RegExp {
  return !matcher || matcher === "*" ? /^/ : new RegExp(`^(?:${matcher})$`);
}

/** An MCP server, started as a program that speaks MCP over stdio. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** What a settings file sets. The user's and a trusted project's are merged (mergeSettings). */
export interface Settings {
  /** Commands that run without asking, matched by their first words: "npm test" allows `npm test -- -u`. */
  allow: string[];
  /** Commands that are refused outright, in every mode: "git push" also blocks `git -C repo push`. */
  deny: string[];
  /** Run commands in the sandbox (default: on where jig has one, which is macOS and Linux). */
  sandbox?: boolean;
  /** Let sandboxed commands use the network (default: off). */
  network?: boolean;
  /**
   * Paths sandboxed commands can't read: secrets (~/.ssh, ~/.aws), or answers a benchmark keeps on the
   * same machine. Absolute, or starting with ~/. jig's own file tools refuse them too, even through a
   * symlink in the project.
   */
  hiddenPaths: string[];
  hooks: Hook[];
  mcpServers: Record<string, McpServerConfig>;
}

/** A project's settings, with the hash of its file that trust is recorded against. */
export interface ProjectSettings {
  path: string;
  /** Hash of the file, so trust in one version doesn't carry over to edits. */
  hash: string;
  settings: Settings;
}

const empty = (): Settings => ({ allow: [], deny: [], hiddenPaths: [], hooks: [], mcpServers: {} });

/**
 * The user's settings (~/.jig/settings.json), and the project's (.jig/settings.json) if it has one; and
 * what in them jig left out, for the user.
 */
export function readSettings(root: string): { user: Settings; project?: ProjectSettings; warnings: string[] } {
  const warnings: string[] = [];
  const userFile = join(jigHome(), "settings.json");
  const user = existsSync(userFile) ? parse(readFileSync(userFile, "utf8"), userFile, warnings) : empty();
  const projectFile = join(root, ".jig", "settings.json");
  if (!existsSync(projectFile)) return { user, warnings };
  const text = readFileSync(projectFile, "utf8");
  const settings = parse(text, projectFile, warnings);
  return { user, project: { path: projectFile, hash: createHash("sha256").update(text).digest("hex"), settings }, warnings };
}

/**
 * The parts of a project's settings that could run code or weaken jig's safety, described for the
 * user. A repository you just cloned could otherwise start programs (hooks, MCP servers) or switch the
 * sandbox off the moment jig runs in it, so these need the user's trust. Deny rules only restrict, so
 * they always apply.
 */
export function needsTrust(settings: Settings): string[] {
  const asks: string[] = [];
  for (const hook of settings.hooks) asks.push(`run a ${hook.event} hook: ${hook.command}`);
  for (const [name, server] of Object.entries(settings.mcpServers)) {
    asks.push(`start the MCP server "${name}": ${[server.command, ...(server.args ?? [])].join(" ")}`);
  }
  if (settings.allow.length) asks.push(`run these commands without asking: ${settings.allow.join(", ")}`);
  if (settings.sandbox === false) asks.push("run commands outside the sandbox");
  if (settings.network) asks.push("give sandboxed commands network access");
  return asks;
}

/** The settings in effect: the user's, plus the project's (only its deny rules and hidden paths, unless it is trusted). */
export function mergeSettings(user: Settings, project: Settings | undefined, trusted: boolean): Settings {
  if (!project) return user;
  // Deny rules and hidden paths only take power away, so they apply whether the project is trusted or not.
  const hiddenPaths = [...user.hiddenPaths, ...project.hiddenPaths];
  if (!trusted) return { ...user, deny: [...user.deny, ...project.deny], hiddenPaths };
  return {
    allow: [...user.allow, ...project.allow],
    deny: [...user.deny, ...project.deny],
    hiddenPaths,
    sandbox: project.sandbox ?? user.sandbox,
    network: project.network ?? user.network,
    hooks: [...user.hooks, ...project.hooks],
    mcpServers: { ...user.mcpServers, ...project.mcpServers },
  };
}

const trustFile = () => join(jigHome(), "trusted-projects.json");

/** Whether the user trusted this exact version of the project's settings. */
export function isTrusted(root: string, project: ProjectSettings): boolean {
  if (!existsSync(trustFile())) return false;
  return JSON.parse(readFileSync(trustFile(), "utf8"))[root] === project.hash;
}

/** Records that the user trusts this version of the project's settings, in ~/.jig/trusted-projects.json. */
export function trust(root: string, project: ProjectSettings): void {
  const trusted = existsSync(trustFile()) ? JSON.parse(readFileSync(trustFile(), "utf8")) : {};
  trusted[root] = project.hash;
  mkdirSync(dirname(trustFile()), { recursive: true });
  writeFileSync(trustFile(), `${JSON.stringify(trusted, null, 2)}\n`);
}

function parse(text: string, file: string, warnings: string[]): Settings {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`);
  };
  const settings = empty();
  for (const key of ["allow", "deny"] as const) {
    const rules = data[key] ?? [];
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string" || !rule.trim())) {
      fail(`"${key}" must be a list of commands, like ["git push"]`);
    }
    settings[key] = (rules as string[]).map((rule) => rule.trim());
  }
  const hidden = data.hiddenPaths ?? [];
  if (!Array.isArray(hidden) || hidden.some((path) => typeof path !== "string" || !(isAbsolute(path) || path.startsWith("~/")))) {
    fail(`"hiddenPaths" must be a list of absolute paths or paths starting with ~/, like ["~/.ssh"]`);
  }
  settings.hiddenPaths = (hidden as string[]).map((path) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path)));
  for (const key of ["sandbox", "network"] as const) {
    if (data[key] === undefined) continue;
    if (typeof data[key] !== "boolean") fail(`"${key}" must be true or false`);
    settings[key] = data[key] as boolean;
  }
  const hooks = (data.hooks ?? {}) as Record<string, unknown>;
  for (const [event, list] of Object.entries(hooks)) {
    // Settings written for Claude Code can hook events jig doesn't have (SessionStart, UserPromptSubmit):
    // those hooks are left out, not the whole file.
    if (!HOOK_EVENTS.includes(event as HookEvent)) {
      warnings.push(`${file}: jig has no hook event "${event}", so those hooks don't run (it has ${HOOK_EVENTS.join(", ")}).`);
      continue;
    }
    if (!Array.isArray(list)) fail(`"hooks.${event}" must be a list of {"matcher", "command"}`);
    for (const hook of list as Record<string, unknown>[]) {
      if (typeof hook?.command !== "string") fail(`every hook in "hooks.${event}" needs a "command"`);
      if (hook.matcher !== undefined && typeof hook.matcher !== "string") fail(`a hook's "matcher" must be a string`);
      try {
        hookMatcher(hook.matcher as string | undefined);
      } catch (err) {
        fail(`the hook matcher "${hook.matcher}" is not a valid regular expression (${(err as Error).message})`);
      }
      settings.hooks.push({ event: event as HookEvent, matcher: hook.matcher as string | undefined, command: hook.command as string });
    }
  }
  const servers = (data.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, server] of Object.entries(servers)) {
    if (typeof server?.command !== "string") fail(`MCP server "${name}" needs a "command"`);
    if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string"))) {
      fail(`MCP server "${name}": "args" must be a list of strings`);
    }
    settings.mcpServers[name] = { command: server.command as string, args: server.args as string[] | undefined, env: server.env as Record<string, string> | undefined };
  }
  return settings;
}
