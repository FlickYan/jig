// grep's reading and matching, run in a worker thread so that grep.ts can stop it. A regular expression can
// take exponentially long on some lines, and one running in jig's own thread can't be stopped at all, not
// even by Ctrl+C. It gets the files to search, keeps `progress` at the step it is at, and sends back the
// matching lines.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const MAX_MATCHES = 200; // lines shown
const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 5_000_000;

export interface SearchJob {
  files: string[];
  cwd: string;
  pattern: string;
  flags: string;
  /** Shared with grep.ts: 2n while the worker reads file n, and 2n + 1 while it matches the file's lines. */
  progress: Int32Array;
}

export interface SearchResult {
  shown: string[];
  total: number;
}

const { files, cwd, pattern, flags, progress } = workerData as SearchJob;
const regex = new RegExp(pattern, flags);
const shown: string[] = [];
let total = 0;
for (const [n, file] of files.entries()) {
  Atomics.store(progress, 0, 2 * n);
  // Size first: reading a big file only to skip it is how a search of a whole container ran out of
  // memory in the Terminal-Bench runs (the process was killed at the container's 2 GB limit).
  const info = await stat(resolve(cwd, file)).catch(() => null);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
  const bytes = await readFile(resolve(cwd, file)).catch(() => null);
  if (!bytes || bytes.subarray(0, 8192).includes(0)) continue;
  Atomics.store(progress, 0, 2 * n + 1);
  bytes
    .toString("utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!regex.test(line)) return;
      total++;
      if (shown.length < MAX_MATCHES) shown.push(`${file}:${i + 1}: ${clip(line.replace(/\r$/, ""))}`);
    });
}
parentPort!.postMessage({ shown, total } satisfies SearchResult);

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}
