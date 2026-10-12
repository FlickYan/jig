// What the commands jig runs during a benchmark must not read. jig's sandbox lets commands read anything
// on the machine, which is where the answers are kept too: in milestone 14 an attempt found its task's
// folder by searching the disk, read the solution and ran the hidden tests. So every run that starts jig
// (bench/run.ts, bench/memory.ts, and bench/evolve.ts for the candidates it proposes) writes its jig home's
// settings with these paths in hiddenPaths. Versions of jig before milestone 18 ignore the setting.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(BENCH);

/**
 * Every suite's tasks and generators, the runs' logs and sessions (other attempts' work), Terminal-Bench's
 * jobs, and the repository's history, which holds all of them.
 */
export const ANSWERS = [join(ROOT, ".git"), BENCH, join(ROOT, "eval")];

/** Where an attempt's home directory goes: outside bench/, which is hidden, and outside the temp directories. */
export const HOMES = join(ROOT, ".bench-homes");

/** Writes the settings of a jig home so that the sandbox hides the answers from jig's commands. */
export function hideAnswers(jigHome: string): void {
  mkdirSync(jigHome, { recursive: true });
  writeFileSync(join(jigHome, "settings.json"), `${JSON.stringify({ hiddenPaths: ANSWERS }, null, 2)}\n`);
}
