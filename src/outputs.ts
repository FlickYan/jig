// --outputs: the files a task hands back in its events. A backend that runs jig as a task (see
// docs/server.md) can't reach the project's folder afterwards, so it names up to MAX_OUTPUTS files before
// the run, and jig writes one `outputs` event with their text just before the end, however the run ended.
//
// The read is jig's own, outside the sandbox, of paths in a folder the task's commands control: under the
// service's local runner jig is the service's user, on the service's machine. So a path is read only if it
// is a regular file that really lies in the project (see readOutput), and all of it is synchronous, as the
// end may be written from jig's exit handler.

import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { redactSecrets } from "./secrets.ts";
import { decodeUTF8, isInside } from "./tools/util.ts";

/** The most files a run hands back. */
export const MAX_OUTPUTS = 20;
/** The longest path of one, in characters. */
export const MAX_OUTPUT_PATH = 512;
/** The most bytes of one file. */
export const OUTPUT_BYTES = 256 * 1024;
/**
 * The most bytes of all the texts together, as the event's line holds them: JSON's escapes counted (a
 * newline or a quote is two bytes there, a control character six), so the line stays under the mebibyte the
 * service's runners read of one (MAX_LINE), with room for the paths and for what the redaction adds.
 */
export const OUTPUTS_BYTES = 768 * 1024;

/**
 * Why a file isn't handed back: no such file; not a regular file that lies in the project (a folder, a link,
 * a pipe, a device, a path that leads out, one jig can't open); over OUTPUT_BYTES, or over OUTPUTS_BYTES with
 * the files before it; or hidden from jig's file tools. (not_text was a file that isn't UTF-8 text, from a
 * jig before such files were handed back in base64.)
 */
export type OutputProblem = "missing" | "not_a_file" | "too_large" | "not_text" | "hidden";

/**
 * One file of the outputs event: its text; its bytes in base64, for a file that isn't UTF-8 text or holds a
 * NUL (an image, an archive); or why there is neither.
 */
export type Output = { path: string; text: string } | { path: string; base64: string } | { path: string; problem: OutputProblem };

/** Why --outputs can't take a path, or undefined if it names a file in the project. */
export function outputProblem(path: string): string | undefined {
  if (path === "" || path.includes("\0")) return "is empty or holds a NUL byte";
  if (path.length > MAX_OUTPUT_PATH) return `is longer than ${MAX_OUTPUT_PATH} characters`;
  if (isAbsolute(path) || /^[\\/]|^[a-zA-Z]:/.test(path)) return "is absolute";
  const parts = path.split(/[\\/]/);
  if (parts.includes("..")) return "leads out of the project (..)";
  if (["", "."].includes(parts.at(-1)!)) return "names a folder, not a file";
  // The event's entry must say the path as it was asked, or the service can't tell whose it is: the events'
  // redaction rewrites what looks like a secret, and half a surrogate pair doesn't come through argv.
  if (!path.isWellFormed() || redactSecrets(path).text !== path) return "isn't text an event can hold as it is (it looks like a secret, or holds half a surrogate pair)";
  return undefined;
}

/** How the bytes of a text count toward OUTPUTS_BYTES: as JSON writes them, without the quotes. */
export function eventBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/**
 * The outputs event's files: each of `paths` once, in the order given, with its text or its problem. `hides`
 * says whether a real path is hidden from the file tools (tools/util.ts's hiddenTest). It never throws.
 */
export function readOutputs(root: string, paths: string[], hides: (real: string) => unknown = () => false): Output[] {
  let realRoot: string | undefined;
  try {
    realRoot = realpathSync(root);
  } catch {
    // The project itself is gone: so is every file in it.
  }
  let total = 0;
  return [...new Set(paths)].slice(0, MAX_OUTPUTS).map((path): Output => {
    const read = realRoot === undefined ? "missing" : readOutput(root, realRoot, path, hides);
    if (typeof read === "string") return { path, problem: read };
    if ("base64" in read) {
      // Bytes as they are: nothing in them is redacted, as nothing in what a task encodes itself is.
      if (total + read.base64.length > OUTPUTS_BYTES) return { path, problem: "too_large" };
      total += read.base64.length;
      return { path, base64: read.base64 };
    }
    // As the event will hold it: the events' redaction can make a text longer (a URL's password becomes
    // [REDACTED]), so it is done here, before the bounds, and finds nothing more when the event is written.
    const text = redactSecrets(read.text).text;
    const bytes = eventBytes(text);
    if (Buffer.byteLength(text) > OUTPUT_BYTES || total + bytes > OUTPUTS_BYTES) return { path, problem: "too_large" };
    total += bytes;
    return { path, text };
  });
}

/**
 * One file's text, or why not. The folder is the task's commands' to change, while jig reads it, so the
 * path is checked twice. First by name: it must be a regular file, not a link, whose real path lies in the
 * project's real path (so no folder on the way is a link that leads out) and isn't hidden. Then it is
 * opened, and what was opened is checked, since a command still running could have swapped a folder for a
 * link in between: O_NOFOLLOW refuses a link as the last part, O_NONBLOCK returns at once from a named pipe
 * (which a blocking open would wait at for a writer, in jig's exit handler), fstat says whether the
 * descriptor is a regular file, and where the descriptor really leads is asked of the kernel
 * (/proc/self/fd, see openedAt) and held to the same two rules. Only then is it read, from that descriptor,
 * OUTPUT_BYTES and one more at most.
 *
 * A hard link to a file outside the project can't be told from a file: it is one. The sandbox keeps
 * commands from making a link to a file they can't read, and what they can read they could have copied in.
 */
function readOutput(root: string, realRoot: string, path: string, hides: (real: string) => unknown): { text: string } | { base64: string } | OutputProblem {
  if (outputProblem(path)) return "not_a_file";
  const abs = resolve(root, path);
  if (!isInside(root, abs)) return "not_a_file";
  const allowed = (real: string): OutputProblem | undefined => (!isInside(realRoot, real) ? "not_a_file" : hides(real) ? "hidden" : undefined);
  let fd: number | undefined;
  try {
    // A link among the folders on the way is followed only if it stays in the project and out of what is
    // hidden: asked before the file is looked for, or "missing" against "not_a_file" would say which names
    // there are in a folder the sandbox hides from the task's commands.
    let dir = root;
    for (const part of abs.slice(root.length).split(sep).filter(Boolean).slice(0, -1)) {
      dir = join(dir, part);
      const on = lstatSync(dir, { throwIfNoEntry: false });
      if (!on) return "missing";
      if (!on.isSymbolicLink()) continue;
      let led: string;
      try {
        led = realpathSync(dir);
      } catch {
        return "not_a_file"; // a link to nothing, or round in a circle
      }
      const refused = allowed(led);
      if (refused) return refused;
    }
    const named = lstatSync(abs, { throwIfNoEntry: false });
    if (!named) return "missing";
    if (!named.isFile()) return "not_a_file";
    const refused = allowed(realpathSync(abs));
    if (refused) return refused;
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return "not_a_file";
    const real = openedAt(fd, abs, opened);
    if (real === undefined) return "not_a_file";
    const moved = allowed(real);
    if (moved) return moved;
    if (opened.size > BigInt(OUTPUT_BYTES)) return "too_large";
    // One byte past the cap tells a file that grew since from one that fits.
    const bytes = Buffer.alloc(OUTPUT_BYTES + 1);
    let length = 0;
    for (let n; length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0; ) length += n;
    if (length > OUTPUT_BYTES) return "too_large";
    const read = bytes.subarray(0, length);
    const text = read.includes(0) ? undefined : decodeUTF8(read);
    return text === undefined ? { base64: read.toString("base64") } : { text };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOTDIR: a file is where a folder on the way would be. Anything else (ELOOP for a link put there since
    // the look, EACCES, ENXIO for a socket, a path too long) is a file jig doesn't read.
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "not_a_file";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Where an open descriptor really leads, or undefined if that can't be known. On Linux the kernel says
 * (/proc/self/fd/N is a link to the path of what was opened, however the names leading to it were changed
 * since). Elsewhere, or where /proc isn't mounted, the path's real path is taken again and counts only if
 * the file there is the one opened, by device and inode.
 */
function openedAt(fd: number, abs: string, opened: { dev: bigint; ino: bigint }): string | undefined {
  if (process.platform === "linux") {
    try {
      // A file removed since reads "<path> (deleted)", which lies where the path did.
      const real = readlinkSync(`/proc/self/fd/${fd}`);
      if (isAbsolute(real)) return real;
    } catch {
      // No /proc here: the other way.
    }
  }
  const real = realpathSync(abs);
  const there = statSync(real, { bigint: true });
  return there.dev === opened.dev && there.ino === opened.ino ? real : undefined;
}
