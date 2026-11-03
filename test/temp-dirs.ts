import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Directories the tests make in the temp directory, removed after each test: each test file that makes
// them runs afterEach(removeTempDirs). Left there, each run of the suite added over 400, and 200 MB.

const made: string[] = [];

/** A new directory in the temp directory, its name starting with `prefix`, for removeTempDirs to remove. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Removes the directories tempDir made, with everything in them. */
export async function removeTempDirs(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
