import { homedir } from "node:os";
import { join } from "node:path";

/** jig's own directory: sessions, snapshots and user settings. $JIG_HOME, or ~/.jig. */
export function jigHome(): string {
  return process.env.JIG_HOME ?? join(homedir(), ".jig");
}

/** A directory name for a project: its path with / replaced by -. */
export function projectKey(root: string): string {
  return root.replace(/[\\/:]/g, "-");
}
