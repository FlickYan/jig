// bash: runs a command in a fresh shell, in the sandbox when there is one and in a process group of its
// own, so a timeout, Ctrl+C or jig's exit stops everything it started; jig's API keys are kept out of its
// environment. The model gets the output and the exit code; a job left in the background keeps running, in
// bubblewrap's session until jig exits (see sandbox.ts's Keeper), and under Seatbelt or with no sandbox as
// in a terminal, outliving jig. A long output is cut from the middle, and the whole of it goes to a file the
// model can search. Unless --no-test-notes, the result of a test run that ran no tests says so (noTestsNote).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, openSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { Sandbox } from "../sandbox.ts";
import type { Tool, ToolContext } from "./index.ts";
import { parseCommand, quoteWord, TEST_COMMAND, withoutHeredocs } from "./shell.ts";
import { type FileVersions, hiddenTest, isInside, realTargetSync, withoutKeys } from "./util.ts";

const DEFAULT_TIMEOUT = 120; // seconds
const MAX_TIMEOUT = 600;
// Characters of output the model sees: all of it, or the first and last half of this. It leaves room for
// the notes and the exit code within the loop's own cut (MAX_OUTPUT_CHARS, 40,000), which keeps a result's
// head and tail too, but doesn't know where the whole output is.
const SHOWN = 39_000;
const MAX_SAVED = 100_000_000; // characters of output kept in files, in all
export const LINGER_MS = 1000; // how long to wait, once the shell has exited, for a background job's last output
const STILL_RUNNING =
  "(The command has finished, but something it started in the background is still running with this output " +
  "open. jig didn't wait for it, so its later output isn't shown.)";

const ABOUT = "Run a shell command with bash in the working directory. Returns stdout and stderr combined, then the exit code.";
const RULES =
  "Each call starts a fresh shell, so cd and variables do not carry over: chain commands with && instead. There is " +
  "no stdin, so anything interactive gets end-of-file; use non-interactive flags. To leave a server running, start " +
  "it in the background with its output redirected to a file.";

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description:
      `${ABOUT} Use it to run tests, builds and git; to search or read files, the grep, glob and read_file tools ` +
      `are usually better. ${RULES}`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout: { type: "integer", description: `Seconds before the command is killed (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})` },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  kind: "run",
  describe: ({ command }) => String(command),

  async run(input, { cwd, signal, versions, sandbox, dirs = [], hidden, outputs, count, testNotes }) {
    const { command, timeout = DEFAULT_TIMEOUT } = input as { command: string; timeout?: number };
    const seconds = Math.min(Math.max(timeout, 1), MAX_TIMEOUT);
    const output = await runCommand(command, cwd, seconds, signal, sandbox, outputs, count);
    await recordViewedFiles(command, cwd, versions, dirs);
    const note = testNotes ? await noTestsNote(command, output, { cwd, dirs, hidden }) : undefined;
    if (!note) return output;
    count?.("bash.noTests");
    // On the line before the exit code, which stays last: failedTestRun reads it there.
    const last = output.lastIndexOf("\n") + 1;
    return `${output.slice(0, last)}${note}\n${output.slice(last)}`;
  },
};

/** What unittest and pytest print when a run ran no tests, and when one ran some. */
const RAN_NONE = /^Ran 0 tests in |^NO TESTS RAN$|\bno tests ran in |^collected 0 items/m;
const RAN_SOME = /^Ran [1-9]\d* tests? in |\b[1-9]\d* (passed|failed)\b/m;
/**
 * What pytest prints where it couldn't collect the tests: it then runs none and exits with 2, or with 4 for a
 * conftest.py (with --continue-on-collection-errors, it runs those it could collect, and exits with 1).
 * unittest counts a test module it can't import as a test that failed.
 */
const UNCOLLECTED = /^collected \d+ items? \/ \d+ errors?|\bERROR collecting |\bInterrupted: \d+ errors? during collection|^ImportError while loading conftest /m;
/** The runners that exit with 5 when they ran no tests (unittest from Python 3.12), and the last of them followed by &&. */
const RUNNER = /\b(unittest|pytest)\b/;
// Not an earlier one: where its && went on to the later one, which printed the output, what followed it ran
// (`which pytest && pytest`, `pytest --version && python -m unittest`).
const LAST_RUNNER_THEN = /\b(unittest|pytest)\b(?![\s\S]*\b(unittest|pytest)\b)[^\n;|&]*&&/;
/** The folders a note names at most, so that a project with many doesn't get a long note. */
const MAX_FOLDERS = 5;

/**
 * Test notes (on unless --no-test-notes): what jig adds to the result of a test run in which unittest or pytest
 * ran no tests, by what they print or their exit code, and no run ran any; or undefined. It says that no tests
 * ran; where the command's last runner, which then exits with an error, was followed by &&, and the exit code
 * doesn't say that what followed ran, that the commands after it didn't run; and for unittest, which folders
 * its discovery doesn't enter where it ran, but not one the command already starts it in or names a file or
 * module in. In milestone 30's evolve2 runs, 29 attempts ran unittest from a project whose tests/ had no
 * __init__.py, and it found no tests; in 22 of them the model's own checks came after its &&
 * (`python - <<'PY'`) and didn't run either, which the result didn't say.
 */
export async function noTestsNote(command: string, output: string, { cwd, dirs = [], hidden }: Pick<ToolContext, "cwd" | "dirs" | "hidden">): Promise<string | undefined> {
  if (!TEST_COMMAND.test(command) || RAN_SOME.test(output)) return undefined;
  // The exit code is the last command's, so 5 says no tests ran only where such a runner is among the commands.
  const commands = withoutHeredocs(command);
  // Only where every runner the command names is one of these, whose output jig reads: another kind's tests
  // may have run, before or after them, whatever they printed (`pytest -q; go test ./...`).
  if (TEST_COMMAND.test(commands.replace(/\b(unittest|pytest)\b/g, " "))) return undefined;
  const byExitCode = /\nExit code: 5$/.test(output) && RUNNER.test(commands);
  const uncollected = UNCOLLECTED.test(output);
  if (!byExitCode && !uncollected && !RAN_NONE.test(output)) return undefined;
  const said = ["no tests ran."];
  // `2>&1` and `&>` are no lists.
  const lists = commands.replace(/\d*[<>]&\d*|&>>?/g, " ");
  // Before Python 3.12, unittest said OK and exited with 0, so what followed ran. So did it where the command
  // exited with 0 and its last list is the runner's (after the &&, only more && and pipes): the exit code is
  // then that list's, whatever an earlier run printed (`pytest -q; python -m unittest && ...`, pytest unable
  // to collect its tests). A later list's says nothing of it: in milestone 30's runs, a line `echo ALL_OK`
  // after a heredoc's check that didn't run.
  const then = LAST_RUNNER_THEN.exec(lists);
  const after = then ? lists.slice(then.index + then[0].length).trimEnd() : "";
  const ranOn = /\nExit code: 0$/.test(output) && !/;|\n|\|\||(?<!&)&(?!&)/.test(after);
  if ((byExitCode || uncollected || /no tests ran/i.test(output)) && then && !ranOn) {
    said.push("The test runner exits with an error code then, so the commands after its && didn't run.");
  }
  // Where the unittest runs ran, if all in one folder jig can tell; the folders are named from there.
  const runs = unittestRuns(lists, cwd);
  const where = runs.every(({ dir }) => dir === runs[0].dir) ? runs[0]?.dir : undefined;
  const unentered = where ? await unenteredFolders(where, [cwd, ...dirs], hidden) : [];
  const folders = unentered.filter((folder) => !runs.some(({ args }) => namesFolder(args, folder, where!))).map(quoteWord);
  if (folders.length) {
    const listed = folders.length > MAX_FOLDERS ? [...folders.slice(0, MAX_FOLDERS), `${folders.length - MAX_FOLDERS} more`] : folders;
    const [named, holds, start] =
      folders.length === 1
        ? [folders[0], "holds", `\`unittest discover -s ${folders[0]}\` starts it there`]
        : [`${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`, "hold", "`unittest discover -s <folder>` starts it in one"];
    said.push(`unittest's discovery enters only packages, and ${named} ${holds} test*.py files but no __init__.py: ${start}.`);
  }
  return `(Note from jig: ${said.join(" ")})`;
}

// A cd or pushd to a path as written, with no variable, ~, glob, option or substitution: where it goes is known.
const LITERAL_CD = /^\s*(?:cd|pushd)\s+(?:([^\s"'`$\\~*?[\]{}()<>#-][^\s"'`$\\*?[\]{}()<>]*)|"([^"`$\\]+)"|'([^']+)')\s*$/;

/**
 * What each unittest run in a command is given, up to the end of its command, and the folder it runs in: jig's
 * cwd, or where literal cd and pushd commands before it took it (`cd backend && python -m unittest`). Undefined
 * after any other cd, pushd or popd (`cd "$APP"`, one in a subshell, a pipeline's or a background job's
 * included, or in a quoted command), as it can't tell.
 */
function unittestRuns(lists: string, cwd: string): { args: string; dir?: string }[] {
  const runs: { args: string; dir?: string }[] = [];
  let dir: string | undefined = cwd;
  // Each command, with the separators around it: one in a pipeline (`cd backend | cat`), or followed by a single
  // & (`cd backend &`), runs in a subshell.
  const parts = lists.split(/(&&|\|\||[;|&\n])/);
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i];
    const subshell = parts[i - 1] === "|" || parts[i + 1] === "|" || parts[i + 1] === "&";
    const cd = subshell ? null : LITERAL_CD.exec(part);
    if (cd) dir &&= resolve(dir, cd[1] ?? cd[2] ?? cd[3]);
    else if (/\b(cd|pushd|popd)\b/.test(part)) dir = undefined;
    for (const [, args] of part.matchAll(/\bunittest\b(.*)/g)) runs.push({ args, dir });
  }
  return runs;
}

/**
 * The folders in `dir` with test*.py files (unittest's pattern) but no __init__.py, which unittest's discovery
 * from there doesn't enter. Not a folder the settings hide, nor one whose only test files they hide: commands
 * can't read those either.
 */
async function unenteredFolders(dir: string, roots: string[], hidden: string[] = []): Promise<string[]> {
  const hides = hiddenTest(hidden, roots);
  const shown = (path: string) => !hides(realTargetSync(path) ?? path);
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const folder = join(dir, entry.name);
    if (!entry.isDirectory() || entry.name.startsWith(".") || !shown(folder)) continue;
    const names = await readdir(folder).catch((): string[] => []);
    if (!names.includes("__init__.py") && names.some((name) => /^test.*\.py$/.test(name) && shown(join(folder, name)))) found.push(entry.name);
  }
  return found.sort();
}

/**
 * Whether a unittest run's arguments already start its discovery in a folder (`discover -s tests`), or name a
 * file or module in it (`tests/test_app.py`, `tests.test_app`), which it imports without an __init__.py. Then
 * that isn't why it ran no tests. A bare `unittest tests` doesn't: it loads the folder as a module, with none.
 */
function namesFolder(args: string, folder: string, dir: string): boolean {
  // Split at spaces and at =, but not in quotes, which then go: a name quoteWord quoted reads as it was.
  const words = (args.match(/(?:'[^']*'|"[^"]*"|\\.|[^\s='"\\])+/g) ?? []).map((word) => word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, "$1$2$3"));
  return words.some((word) => {
    const path = relative(dir, resolve(dir, word));
    return path.startsWith(`${folder}${sep}`) || word.startsWith(`${folder}.`) || (path === folder && words.includes("discover"));
  });
}

// Programs that print a file's content. Models often look at files this way instead of with read_file.
const VIEWERS = new Set(["cat", "head", "tail", "nl"]);

/**
 * A file the model printed with `cat` (or head, tail, nl) counts as read, for write_file's check that a
 * file it overwrites was read as it is. The benchmark showed why: without this, changes after a `cat`
 * were refused and had to be redone.
 */
async function recordViewedFiles(command: string, cwd: string, versions: FileVersions, dirs: string[]): Promise<void> {
  for (const [program, ...args] of parseCommand(command) ?? []) {
    if (!VIEWERS.has(program)) continue;
    for (const arg of args) {
      const abs = resolve(cwd, arg);
      if (arg.startsWith("-") || ![cwd, ...dirs].some((dir) => isInside(dir, abs))) continue;
      const info = await stat(abs).catch(() => null);
      if (info?.isFile()) await versions.record(abs, info);
    }
  }
}

/**
 * Why a task's signal stopped something, for its result: the words the task was stopped with (the CLI's, at
 * --time-limit), or else `byUser`, since Ctrl+C gives none.
 */
export function whyStopped(signal: AbortSignal | undefined, byUser: string): string {
  return typeof signal?.reason === "string" ? signal.reason : byUser;
}

// The process groups of the commands and hooks (hooks.ts) running now, for killCommands.
export const running = new Set<number>();

/**
 * Kills the commands and hooks still running, with everything they started, as Ctrl+C does: for jig's exit.
 * Each has a session of its own, which closing the terminal doesn't reach, and apart from the Linux sandbox,
 * whose commands end with jig (see sandbox.ts's Keeper), nothing else would stop it with jig.
 */
export function killCommands(): void {
  for (const group of running) killGroup(group);
}

function killGroup(group: number): void {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // the process group has already exited
  }
}

/**
 * Runs a command; resolves to its output (its head and tail, if it is long) and how it ended, and rejects
 * only if it can't be started. Given `files`, the whole of a long output is kept in one of them, and given
 * `count`, cutting it counts as the loop's own cut does (the loop's then has nothing left to cut).
 */
export async function runCommand(
  command: string,
  cwd: string,
  seconds: number,
  signal?: AbortSignal,
  sandbox?: Sandbox,
  files?: OutputFiles,
  count?: ToolContext["count"],
): Promise<string> {
  // Undefined if bubblewrap couldn't join the session's namespace, which had just ended, and so started
  // nothing: wrapped again, the command runs in a new one, once (see sandbox.ts's Keeper).
  const result = await runOnce(command, cwd, seconds, signal, sandbox, files, count, true);
  return result ?? (await runOnce(command, cwd, seconds, signal, sandbox, files, count, false))!;
}

function runOnce(
  command: string,
  cwd: string,
  seconds: number,
  signal: AbortSignal | undefined,
  sandbox: Sandbox | undefined,
  files: OutputFiles | undefined,
  count: ToolContext["count"] | undefined,
  mayRetry: boolean,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const { program, args, stdio, note: about, couldntJoin } = sandbox?.wrap(command) ?? { program: "bash", args: ["-c", command] };
    // detached puts the command in its own process group, so a timeout or Ctrl+C can kill it together
    // with everything it started (a test runner and its workers, say), not just the shell. `stdio` carries
    // the session's namespace descriptors on Linux (child fds 3 onwards), for the sandbox to join, and a
    // pipe on which bubblewrap reports the command's process before it starts it (see Keeper).
    const child = spawn(program, args, { cwd, env: withoutKeys(), detached: true, stdio: ["ignore", "pipe", "pipe", ...(stdio ?? [])] });
    const group = child.pid; // none if it couldn't be started
    if (group) running.add(group);
    let reported = "";
    const pipe = stdio?.indexOf("pipe") ?? -1;
    if (pipe >= 0) (child.stdio[3 + pipe] as Readable).setEncoding("utf8").on("data", (chunk: string) => (reported += chunk));
    const output = new Output(files);
    let killedBecause = "";
    let done = false;
    const kill = (reason: string) => {
      killedBecause ||= reason;
      killGroup(group!);
    };
    const collect = (chunk: string) => {
      if (done) return; // a background job's output, after the call has returned
      output.add(chunk);
    };
    child.stdout!.setEncoding("utf8").on("data", collect); // stdio asks for a pipe at 1 and 2
    child.stderr!.setEncoding("utf8").on("data", collect);

    const timer = setTimeout(() => kill(`it timed out after ${seconds}s`), seconds * 1000);
    const onAbort = () => kill(whyStopped(signal, "the user interrupted it"));
    signal?.addEventListener("abort", onAbort, { once: true });
    let lingering: NodeJS.Timeout | undefined;
    const settle = () => {
      done = true;
      if (group) running.delete(group); // a job it left in the background keeps running, as in a terminal
      output.close();
      clearTimeout(timer);
      clearTimeout(lingering);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (status: string, note = "") => {
      if (done) return;
      settle();
      if (output.cut) count?.("output.truncated");
      // The sandbox's own note, if it has one (see Sandbox.wrap), after the command's.
      const notes = [note, about].filter(Boolean).map((line) => `${line}\n`).join("");
      resolve(`${output.shown().trimEnd() || "(no output)"}\n\n${notes}${status}`);
    };
    const status = (code: number | null, killSignal: NodeJS.Signals | null) =>
      killedBecause ? `Killed: ${killedBecause}.` : `Exit code: ${code ?? killSignal}`;

    child.on("error", (err) => {
      settle();
      reject(err);
    });
    // "close" comes once the output pipes have closed, which is normally when the command has finished.
    // But a job it left in the background can hold them: `cd app && server > log &` runs the whole list
    // in a subshell, which keeps the pipes while it waits for the server. So once the shell has exited,
    // wait a moment for the last output, then return and leave the job running, as a terminal would.
    child.on("exit", (code, killSignal) => {
      lingering = setTimeout(() => {
        // Keep reading what the job prints, so it never blocks on a full pipe, without keeping jig alive.
        for (const stream of [child.stdout, child.stderr]) (stream as Partial<Socket>).unref?.();
        finish(status(code, killSignal), STILL_RUNNING);
      }, LINGER_MS);
    });
    child.on("close", (code, killSignal) => {
      // Only here, with every pipe closed, is all that bubblewrap reported in.
      if (mayRetry && !done && !killedBecause && code !== 0 && couldntJoin?.(reported)) {
        settle();
        resolve(undefined);
        return;
      }
      finish(status(code, killSignal));
    });
  });
}

/**
 * A command's output, as much of it as the model sees: all of it up to SHOWN characters, or else the first
 * and last SHOWN / 2, with the whole of it in a file when there are files to keep it in. Memory stays the
 * same however much a command prints, so a command that prints a lot runs to the end; it used to be killed
 * at 5 million characters, its exit code lost. Hooks keep what they print this way too, without a file, and
 * with a larger `limit` in place of SHOWN where they need more of it whole.
 */
export class Output {
  private head = "";
  private tail = "";
  private length = 0;
  private file?: OutputFile;
  private readonly files?: OutputFiles;
  private readonly limit: number;

  constructor(files?: OutputFiles, limit = SHOWN) {
    this.files = files;
    this.limit = limit;
  }

  add(chunk: string): void {
    // Once there is more than the model will see, everything so far and all that follows goes to a file.
    if (this.length <= this.limit && this.length + chunk.length > this.limit) this.file = this.files?.create(this.head + this.tail);
    if (this.file) this.files!.add(this.file, chunk);
    this.length += chunk.length;
    const room = this.limit / 2 - this.head.length;
    if (room > 0) {
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    // The tail is cut back only once it has grown to twice what is kept. Cut with every chunk, a tail of
    // millions of characters would be copied each time: 3 seconds for a hook printing 200 MB, not 0.2.
    this.tail += chunk;
    if (this.tail.length > this.limit) this.tail = this.tail.slice(-this.limit / 2);
  }

  /** Whether there is more than the model will see, so only the head and tail are shown. */
  get cut(): boolean {
    return this.length > this.limit;
  }

  /** The command has ended: nothing more goes to its file. */
  close(): void {
    if (this.file) this.files!.close(this.file);
  }

  /** The output, or its head and tail with where the rest is. */
  shown(): string {
    if (this.length <= this.limit) return this.head + this.tail;
    const file = this.file;
    const where = !file
      ? ""
      : `. ${file.whole ? "The whole output is" : `The output's first ${file.size} characters are`} in ${file.path}: ` +
        "search it with grep -n, or print lines of it with sed -n, rather than running the command again";
    return `${this.head}\n\n[... ${this.length - this.limit} characters truncated${where} ...]\n\n${this.tail.slice(-this.limit / 2)}`;
  }
}

/** A file holding a command's output: all of it, or its first `size` characters. */
interface OutputFile {
  path: string;
  fd: number;
  size: number;
  whole: boolean;
}

/**
 * A result with the names of its output files left out. Every run of a command gets a file of its own, so
 * two runs that printed the same have results that differ only in the name, and the loop, which stops a
 * model getting the same results step after step, would never see them as the same.
 */
export function withoutOutputFileNames(text: string): string {
  return text.replace(/jig-output-[0-9a-f]{12}\.log/g, "jig-output.log");
}

/**
 * Where the whole of a long output goes, so the model can search it instead of running the command again:
 * files in the temp directory, which commands can read, sandboxed or not, and other users can't. They hold
 * `limit` characters in all, the oldest making room for new ones, and jig removes them when it exits.
 *
 * Each file is made new, with a name of its own, right in the temp directory, and written only through
 * the descriptor that made it: sandboxed commands can write in the temp directory, and given a directory of
 * jig's there, or a path jig opens again, one could swap in a symlink and have jig write outside the sandbox.
 */
export class OutputFiles {
  private files: OutputFile[] = []; // oldest first
  private size = 0;
  private readonly limit: number;

  constructor(limit = MAX_SAVED) {
    this.limit = limit;
  }

  /** A new file, holding `text` to begin with; undefined if it can't be made. */
  create(text: string): OutputFile | undefined {
    try {
      const path = join(tmpdir(), `jig-output-${randomBytes(6).toString("hex")}.log`);
      const file = { path, fd: openSync(path, "ax", 0o600), size: 0, whole: true };
      this.files.push(file);
      this.add(file, text);
      return file;
    } catch {
      return undefined;
    }
  }

  /** Adds to a file, as far as the limit lets it. Once something is left out, nothing more is added. */
  add(file: OutputFile, text: string): void {
    if (!file.whole) return;
    try {
      // The newest output is the one the model is likely to want.
      while (this.size + text.length > this.limit && this.files[0] !== file) {
        const old = this.files.shift()!;
        this.size -= old.size;
        deleteFile(old.path);
      }
      const part = text.slice(0, this.limit - this.size);
      appendFileSync(file.fd, part);
      file.size += part.length;
      this.size += part.length;
      file.whole = part.length === text.length;
    } catch {
      file.whole = false;
    }
  }

  /**
   * The files jig keeps now, by path. The permission policy lets commands that only read look at these, as
   * the note tells the model to; not other files with names like theirs, which a command can make.
   */
  paths(): string[] {
    return this.files.map((file) => file.path);
  }

  /** Done with a file: its command has ended. */
  close(file: OutputFile): void {
    try {
      closeSync(file.fd);
    } catch {
      // already closed
    }
  }

  /** Deletes the files. */
  remove(): void {
    for (const file of this.files) deleteFile(file.path);
    this.files = [];
    this.size = 0;
  }
}

/** Deletes a file, or a symlink in its place, but not something else a command has put there. */
function deleteFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // a directory, say: the temp directory is the commands' too
  }
}

/** bash without jig's search and read tools beside it (--tools): its description doesn't point at them. */
export const bashOnItsOwn: Tool = { ...bashTool, definition: { ...bashTool.definition, description: `${ABOUT} ${RULES}` } };
