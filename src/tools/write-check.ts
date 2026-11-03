// --check-writes: what write_file and edit_file wrote, checked once it is written, with what is wrong added to
// their result (the call still counts as done). Whole-file rewrites and edits on the last step can leave a file
// broken with no test run after them, and the model then finishes, sure it is done. Two checks:
//
// - The syntax, by the file's extension: python3's ast.parse for .py, node --check for .js, .mjs and .cjs,
//   bash -n for .sh, run as commands run (in the sandbox, without jig's keys), for 5 seconds at most and only
//   where commands find the program; and JSON.parse for .json, in jig. A program runs only where the model
//   could run it on the file itself without asking (see ToolContext.mayRun), or that check is left out: the
//   model can pick the program (a virtualenv's python3 first on the PATH, whose files it can write) and what
//   it runs as it starts, so the check is a command of the model's like any other. Only an error the
//   change made is reported: the old content is checked too, and an error it had already (the same, line
//   numbers aside) is left alone, as these checks name only the first error, and a file one can't read at all
//   (JSX in a .js file, comments in a .json one) would otherwise be reported at every change. The old content
//   is checked in its place, before it is replaced: where a file lies can decide how it parses (a
//   package.json's "type", for node).
// - For write_file, which replaces a file whole: lines like "// ... existing code ..." that the old content
//   didn't have, in a file it made much shorter. Models write them for the code they didn't repeat, and that
//   code is then gone from the file.
//
// Off by default, so a benchmark can measure a run with it against one without (see --stats's events).

import { realpath } from "node:fs/promises";
import { extname } from "node:path";
import { runCommand } from "./bash.ts";
import type { ToolContext } from "./index.ts";
import { shownLine } from "./read.ts";
import { countLines, realTarget } from "./util.ts";

/** How long a syntax check may take, in seconds. An object, so that tests can lower it. */
export const checkLimits = { seconds: 5 };

/** A syntax check: its name for the model, and how it finds an error. */
interface Check {
  name: string;
  /** The program it runs on the file, if it runs one, and the script that does, given the file's real path. */
  runs?: { program: string; script(real: string): string };
  /** The line of an error it finds that names the error (see sameError). */
  names: RegExp;
  /**
   * Resolves to the error in `file` (`path` to the model), whose content is `text`, or undefined if it finds
   * none or can't tell. A note the sandbox gives with the command's result goes to `notes`.
   */
  run(file: string, path: string, text: string, ctx: ToolContext, notes: string[]): Promise<string | undefined>;
}

// ast.parse compiles nothing, so it writes no .pyc; -I keeps the project's own modules (an ast.py) out of it,
// and -S the site module, which runs the code of site-packages' .pth files and sitecustomize (ast, sys and
// traceback need no site-packages). format_exception_only is given the error's type too, which Pythons
// before 3.10 (macOS's own is 3.9) require.
const PARSE_PYTHON = `import ast,sys,traceback
s=open(sys.argv[1],"rb").read()
try: ast.parse(s,sys.argv[1])
except Exception as e: sys.exit("".join(traceback.format_exception_only(type(e),e)).rstrip())`;

// On Node 22, node --check passes a .js file with import or export in it, whatever its syntax, where no
// package.json gives it a "type" (Node 24 doesn't). So a .js file it passes but that isn't CommonJS, which node
// would run as a module, is checked again as one, from stdin.
const CHECK_JS = (file: string) =>
  `node --check ${file} && { node --input-type=commonjs --check <${file} 2>/dev/null || node --input-type=module --check <${file}; }`;

const NODE = command("node --check", "node", (file) => `node --check ${file}`, /^SyntaxError: /m);
const CHECKS: Record<string, Check> = {
  ".py": command("python3's ast.parse", "python3", (file) => `python3 -I -S -c '${PARSE_PYTHON}' ${file}`, /^\w*Error: /m),
  ".js": command("node --check", "node", CHECK_JS, /^SyntaxError: /m),
  ".mjs": NODE,
  ".cjs": NODE,
  ".sh": command("bash -n", "bash", (file) => `bash -n ${file}`, /syntax error/),
  ".json": { name: "JSON.parse", names: /./, run: async (_file, _path, text) => jsonError(text) },
};

/**
 * Checks a change to `file` (`path` to the model) by write_file or edit_file, as --check-writes asks: called
 * before the change, with the file's content then (undefined for a new file), which it checks. It resolves to
 * what checks the change once it is written: given the content written, that resolves to what to add to the
 * tool's result, or "" when nothing is wrong. `whole` says the change replaced the whole file (write_file).
 */
export async function checkChange(file: string, path: string, old: string | undefined, ctx: ToolContext, whole = false): Promise<(text: string) => Promise<string>> {
  // Asked once, so the old content and the new are both checked, or neither: an error the file had already
  // isn't then taken for the change's.
  const check = await checkFor(file, ctx);
  const notes: string[] = [];
  const before = old !== undefined && check ? await check.run(file, path, old, ctx, notes) : undefined;
  return async (text) => {
    const found: string[] = [];
    const error = check ? await check.run(file, path, text, ctx, notes) : undefined;
    if (check && error && !(before && sameError(check, before, error))) {
      ctx.count?.("write.syntaxError");
      const since = old === undefined ? "" : before ? " after this change, with another error than before" : " after this change, though it passed before";
      found.push(`A syntax check of ${path} (${check.name}) failed${since}:\n${error}`);
    }
    const left = whole && old !== undefined ? placeholders(old, text) : [];
    if (left.length) {
      ctx.count?.("write.placeholder");
      const more = left.length > SHOWN_PLACEHOLDERS ? `\n  and ${left.length - SHOWN_PLACEHOLDERS} more` : "";
      found.push(
        `${path} went from ${countLines(old!)} lines to ${countLines(text)}, and has lines that look like placeholders for code left out, which it didn't have before:\n` +
          `${left.slice(0, SHOWN_PLACEHOLDERS).join("\n")}${more}\n` +
          "write_file writes the content as given, so the code they stand for is gone from the file: if you left code out, write it back in.",
      );
    }
    return [...found, ...notes].map((part) => `\n\n${part}`).join("");
  };
}

/**
 * The syntax check for `file`, by its extension, if it has one. One that runs a program on it is left out
 * (and counted) unless the model could run that program on the file itself without asking
 * (ToolContext.mayRun), as the program, and what it runs as it starts, can be the model's. The policy is
 * asked about `<program> <file>`, as allow rules and "always" answers name the program, and deny rules are
 * matched against the script that runs too, with the path the file really has once written (realTarget).
 */
async function checkFor(file: string, ctx: ToolContext): Promise<Check | undefined> {
  const check: Check | undefined = CHECKS[extname(file).toLowerCase()];
  if (!check?.runs) return check;
  const real = (await realTarget(file)) ?? file;
  if (ctx.mayRun?.(`${check.runs.program} ${quoted(file)}`, check.runs.script(real))) return check;
  ctx.count?.("write.checkSkipped");
  return undefined;
}

/**
 * A check that runs `program` on the file, by the command `call` makes of its path, as the bash tool runs a
 * command, but for checkLimits.seconds at most, and only where commands find the program. It finds an error
 * when the command fails and its output shows `error`, which tells a syntax error from the program failing
 * some other way (a stub that asks for it to be installed, say). It is given the file's real path, which node
 * would print anyway, shown as the model's.
 */
function command(name: string, program: string, call: (file: string) => string, error: RegExp): Check {
  const script = (real: string) => `command -v ${program} >/dev/null || exit 0; ${call(quoted(real))}`;
  return {
    name,
    runs: { program, script },
    names: error,
    async run(file, path, _text, { cwd, signal, sandbox }, notes) {
      const real = await realpath(file).catch(() => undefined);
      if (!real || signal?.aborted) return undefined;
      // The sandbox tells the model some things once, with a command's result (see Sandbox.wrap): if this is
      // that command, the note is passed on, not lost.
      const noting = sandbox && {
        ...sandbox,
        wrap: (command: string) => {
          const { note, ...wrapped } = sandbox.wrap(command);
          if (note) notes.push(note);
          return wrapped;
        },
      };
      // A check that can't be started finds nothing: the change is written, or about to be, either way.
      const result = await runCommand(script(real), cwd, checkLimits.seconds, signal, noting).catch(() => "");
      // The output, then a blank line and how the command ended: a timeout or Ctrl+C finds nothing.
      const end = result.lastIndexOf("\n\n");
      const output = result.slice(0, end);
      if (!/^Exit code: [1-9]/m.test(result.slice(end)) || !error.test(output)) return undefined;
      // Node's stack and version say nothing about the file; a long line (minified code) is cut as read_file cuts it.
      const lines = output.split("\n").filter((line) => !/^\s+at |^Node\.js v|^\(Use `node --trace-warnings/.test(line));
      const shown = lines.map((line) => shownLine(line.replaceAll(real, path))).join("\n").replace(/^\n+|\s+$/g, "");
      // node names a file it checked from stdin (see CHECK_JS) [stdin].
      return shown.replace(/^\[stdin\]:/, () => `${path}:`);
    },
  };
}

/** A path as one word of a shell command. */
function quoted(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Whether two errors are the same, by the line that names each, but for the numbers in it (lines, positions):
 * an error the old content had moves when the change adds or removes lines before it.
 */
function sameError(check: Check, before: string, after: string): boolean {
  const named = (error: string) => (error.split("\n").find((line) => check.names.test(line)) ?? error).replace(/\d+/g, "");
  return named(before) === named(after);
}

function jsonError(text: string): string | undefined {
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** write_file must leave a file at most this share of its lines for its placeholders to be reported. */
const MUCH_SHORTER = 0.75;
const SHOWN_PLACEHOLDERS = 5;

/** The lines of `text` that look like placeholders and weren't in `old`, by number, if `text` is much shorter. */
function placeholders(old: string, text: string): string[] {
  if (countLines(text) > countLines(old) * MUCH_SHORTER) return [];
  const had = new Set(old.split("\n").map((line) => line.trim()));
  return text.split("\n").flatMap((line, i) => (isPlaceholder(line) && !had.has(line.trim()) ? [`  line ${i + 1}: ${line.trim()}`] : []));
}

// A comment's marks at the start and end of a line: //, #, /* and */ (JSX's {/* */} too), a block comment's *,
// <!-- and -->, -- and ;.
const COMMENT = /^(\/\/+|#+|\{?\/\*+|\*+|<!--|--|;+)|(\*\/\}?|-->)$/g;
const ELLIPSES = /^(\.{3,}|…)|(\.{3,}|…)$/g;
// What a placeholder names as left out: "rest of the module", "existing code", "other methods". "rest of" takes
// a word or two, no more: "...rest of args are forwarded" says what a rest parameter does.
const WHAT = String.raw`(the )?(rest of( the| this| your)?( [\w-]+){1,2}|(existing|remaining|previous|original|other|same) (code|content|implementation|methods|functions|imports|tests|lines|logic))`;
// And what it says of it: unchanged, or left out.
const UNCHANGED = String.raw`((is|are|remains?|stays?) )?(unchanged|omitted|as before)|(remains?|stays?) the same`;
// Next to an ellipsis either will do ("... existing code ...", "... 40 lines omitted"). Without one, a comment
// or brackets must say only the second, maybe after the first ("(unchanged)", "# Rest of the module unchanged").
const NEAR_ELLIPSIS = new RegExp(String.raw`^(keep )?${WHAT}( here)?$|\b(${UNCHANGED})\b`, "i");
const ON_ITS_OWN = new RegExp(String.raw`^((the )?rest |everything else |${WHAT} )?(${UNCHANGED})\.?$`, "i");

/**
 * Whether a line looks like it stands for code left out: a few words next to an ellipsis that name what was
 * left out or say it is unchanged ("// ... existing code ...", "... rest of the file"), or a comment or
 * brackets that say only that it is unchanged, maybe after what it is ("(unchanged)", "# Rest of the module
 * unchanged"). Not an ordinary comment with such a word in it ("// Returns the input unchanged"), nor an
 * ellipsis alone, which is code in Python and YAML.
 */
function isPlaceholder(line: string): boolean {
  const text = line.trim();
  const said = unbracket(text.replace(COMMENT, ""));
  if (said.split(/\s+/).length > 10) return false;
  const words = said.replace(ELLIPSES, "");
  if (words !== said) return NEAR_ELLIPSIS.test(unbracket(words));
  return said !== text && ON_ITS_OWN.test(said);
}

function unbracket(text: string): string {
  return text.trim().replace(/^\((.*)\)$|^\[(.*)\]$/, "$1$2").trim();
}
