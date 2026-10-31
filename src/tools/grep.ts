// grep: a regular expression over the project's files, skipping what git ignores, binary files and files
// over 5 MB. Each match comes back as file:line: text, up to 200 of them. The files are read and matched
// in a worker thread (grep-worker.ts), which a time limit or Ctrl+C stops.

import { basename, extname, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { whyStopped } from "./bash.ts";
import { firstVisible, globToRegExp, listFiles, relativeGlob, searchLimits, walkedNote } from "./files.ts";
import type { SearchJob, SearchResult } from "./grep-worker.ts";
import type { Tool } from "./index.ts";
import { resolveInRoot } from "./util.ts";

// grep-worker.ts from a clone, and grep-worker.js in the npm package, which is compiled.
const WORKER = new URL(`./grep-worker${extname(import.meta.url)}`, import.meta.url);

export const grepTool: Tool = {
  definition: {
    name: "grep",
    description:
      "Search the contents of files with a regular expression (JavaScript syntax). Returns matching lines as " +
      "path:line: text. Searches the whole project by default, skipping .git, node_modules and files git " +
      "ignores, unless path points into them (node_modules/pkg). Use it to find where something is defined " +
      "or used before reading files; read_file can then start at the line number it gives.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "File or directory to search, relative to the working directory (default: .)" },
        include: {
          type: "string",
          description: "Only search files matching this glob, e.g. *.py (any directory) or src/**/*.ts",
        },
        ignore_case: { type: "boolean", description: "Match regardless of case (default false)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  kind: "read",
  describe: ({ pattern, path, include }) =>
    [String(pattern), path && `in ${path}`, include && `(${include})`].filter(Boolean).join(" "),

  async run(input, { cwd, dirs, hidden, signal }) {
    const { pattern, path = ".", include, ignore_case } = input as {
      pattern: string;
      path?: string;
      include?: string;
      ignore_case?: boolean;
    };
    const flags = ignore_case ? "i" : "";
    try {
      new RegExp(pattern, flags);
    } catch (err) {
      throw new Error(`Invalid regular expression: ${(err as Error).message}`);
    }
    const base = resolveInRoot(cwd, path, dirs);
    const { files, capped, gitTimedOut } = await listFiles(cwd, path, dirs, hidden, signal);
    const wanted = include ? files.filter(includes(include, cwd, base)) : files;
    // Reading is what takes the time, so grep reads so many files at most: the first, by name.
    const searched = await firstVisible(cwd, wanted, searchLimits.files, hidden, dirs);
    const { shown, total } = await search({ files: searched.files, cwd, pattern, flags }, signal);

    // Say when files went unsearched, so that what wasn't found isn't taken as absent.
    const unsearched = capped
      ? `the first ${files.length} files: the listing stops there`
      : searched.total > searched.files.length && `the first ${searched.files.length} of ${searched.total} files`;
    const walked = walkedNote(gitTimedOut);
    if (total === 0) return (unsearched ? `No matches in ${unsearched}. Narrow the search with path or include.` : "No matches.") + walked;
    const notes = [total > shown.length && `Showed ${shown.length} of ${total} matches.`, unsearched && `Searched only ${unsearched}.`];
    if (notes.some(Boolean)) shown.push(`\n(${notes.filter(Boolean).join(" ")} Narrow the search with path or include.)`);
    return shown.join("\n") + walked;
  },
};

/**
 * Whether a file matches grep's include glob. Like ripgrep, a glob without "/" matches file names in any
 * directory. One with "/" matches the path below `path`, as glob's pattern does, or the path in the
 * project, which a model may give as well.
 */
function includes(include: string, cwd: string, base: string): (file: string) => boolean {
  const regex = globToRegExp(relativeGlob(include, base));
  if (!include.includes("/")) return (file) => regex.test(basename(file));
  return (file) => regex.test(relative(base, resolve(cwd, file))) || regex.test(file);
}

/**
 * Runs grep-worker.ts on the files, and stops it when the user presses Ctrl+C, or when it has spent
 * searchLimits.seconds on one file: a pattern stuck backtracking, or a read that hangs. A search that goes
 * from file to file isn't stopped, however long it takes in all: that time is reading, and 20,000 files
 * from a cold disk (a fresh container, with --add-dir /) can take half a minute. Meanwhile jig's own
 * thread goes on: the terminal, and other tools that read.
 */
function search(job: Omit<SearchJob, "progress">, signal?: AbortSignal): Promise<SearchResult> {
  // -1 until the worker is at its first file: starting the worker is jig's own work, and isn't timed.
  const progress = new Int32Array(new SharedArrayBuffer(4)).fill(-1);
  const worker = new Worker(WORKER, { workerData: { ...job, progress } satisfies SearchJob });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, result?: SearchResult) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (err) reject(err);
      else resolve(result!);
    };
    // The worker's step at the last look, and since when it has been at it. Looking ten times in the
    // limit, a stuck worker is stopped within 1.2 times the limit.
    let step = -1;
    let since = Date.now();
    const watch = setInterval(() => {
      const now = Atomics.load(progress, 0);
      if (now !== step) [step, since] = [now, Date.now()];
      else if (step >= 0 && Date.now() - since >= searchLimits.seconds * 1000) finish(stuck(job.files, step));
    }, searchLimits.seconds * 100);
    const onAbort = () => finish(new Error(`grep stopped: ${whyStopped(signal, "the user interrupted it")}.`));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.on("message", (result: SearchResult) => finish(null, result));
    worker.on("error", (err: Error) => finish(err));
    worker.on("exit", (code) => finish(new Error(`grep's worker thread stopped (exit code ${code}).`)));
  });
}

/** Why grep stopped a worker that stayed at one step: reading a file, no fault of the pattern, or matching in it. */
function stuck(files: string[], step: number): Error {
  const n = Math.floor(step / 2);
  const file = `${files[n]} (file ${n + 1} of ${files.length})`;
  if (step % 2 === 0) return new Error(`grep stopped: reading ${file} took over ${searchLimits.seconds}s. Leave it out with path or include.`);
  return new Error(
    `grep stopped: matching the pattern in ${file} took over ${searchLimits.seconds}s. A pattern with nested ` +
      "repetition, like (a+)+ or (\\w+\\s?)+, can take exponentially long on some lines: make it simpler, or " +
      "leave the file out with path or include.",
  );
}
