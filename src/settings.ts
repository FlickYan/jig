import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jigHome } from "./paths.ts";

export interface Settings {
  /** Commands that run without asking, matched by their first words: "npm test" allows `npm test -- -u`. */
  allow: string[];
  /** Commands that are refused outright, in every mode: "git push" also blocks `git -C repo push`. */
  deny: string[];
  /** Run commands in the sandbox (default: on where jig has one, which is macOS). */
  sandbox?: boolean;
  /** Let sandboxed commands use the network (default: off). */
  network?: boolean;
}

/**
 * Settings from ~/.jig/settings.json and then the project's .jig/settings.json. The allow and deny lists
 * of both are combined; for the other settings, the project's file wins.
 */
export function loadSettings(root: string): Settings {
  const settings: Settings = { allow: [], deny: [] };
  for (const file of [join(jigHome(), "settings.json"), join(root, ".jig", "settings.json")]) {
    if (!existsSync(file)) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
    }
    settings.allow.push(...strings(data, "allow", file));
    settings.deny.push(...strings(data, "deny", file));
    for (const key of ["sandbox", "network"] as const) {
      if (data[key] === undefined) continue;
      if (typeof data[key] !== "boolean") throw new Error(`${file}: "${key}" must be true or false`);
      settings[key] = data[key];
    }
  }
  return settings;
}

function strings(data: Record<string, unknown>, key: string, file: string): string[] {
  const value = data[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${file}: "${key}" must be a list of commands, like ["git push"]`);
  }
  return value.map((rule: string) => rule.trim());
}
