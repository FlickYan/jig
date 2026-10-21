import assert from "node:assert/strict";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { ask, askTask, Input } from "../src/ui.ts";
import { collectNotices } from "./notices.ts";

// The user's input: one readline interface for the session, fed the bytes a terminal (or a pipe) sends.

const settle = () => new Promise((done) => setImmediate(done));

/** A terminal to read from: `type` sends keys as a terminal does, `shown` is what jig wrote to it. */
function terminal() {
  const keys = Object.assign(new PassThrough(), { isTTY: true, raw: false, setRawMode: (raw: boolean) => ((keys.raw = raw), keys) });
  const screen = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let shown = "";
  screen.on("data", (chunk) => (shown += chunk));
  return {
    input: new Input(keys as unknown as NodeJS.ReadStream, screen as unknown as NodeJS.WriteStream),
    async type(text: string) {
      keys.write(text);
      await settle();
    },
    raw: () => keys.raw,
    shown: async () => (await settle(), shown),
    resize: () => screen.emit("resize"),
  };
}

describe("the input at a terminal", () => {
  it("joins a paste and the line after it into one message, with pastes marked only while asking", async () => {
    const term = terminal();
    const answer = askTask("> ", term.input);
    await term.type("\x1b[200~the build fails with this error:\rTypeError: x is undefined\r    at main (app.js:3)\x1b[201~");
    assert.equal(term.raw(), true);
    await term.type("\r");
    assert.equal(await answer, "the build fails with this error:\nTypeError: x is undefined\n    at main (app.js:3)");
    assert.equal(term.raw(), false, "so Ctrl+C during the task is the signal that stops it");
    const shown = await term.shown();
    assert.ok(shown.startsWith("\x1b[?2004h") && shown.endsWith("\x1b[?2004l"), JSON.stringify(shown));
    assert.equal(shown.split("… ").length, 3, "a prompt for each line after the first");
  });

  it("brings back earlier tasks with Up, but not answers to questions or the lines of a paste", async () => {
    const term = terminal();
    const entered = async (read: Promise<string | null>, keys: string) => (await term.type(keys), read);
    assert.equal(await entered(ask("Trust this project? ", undefined, term.input), "y\r"), "y");
    assert.equal(await entered(askTask("> ", term.input), "\x1b[A\r"), "", "nothing to bring back yet");
    assert.equal(await entered(askTask("> ", term.input), "say hi\r"), "say hi");
    assert.equal(await entered(ask("Allow? ", undefined, term.input), "y\r"), "y");
    assert.equal(await entered(askTask("> ", term.input), "\x1b[200~line one\rline two\x1b[201~\r"), "line one\nline two");
    assert.equal(await entered(askTask("> ", term.input), "\x1b[A\r"), "say hi");
    // Ctrl+C drops what was typed and asks again, the history still there.
    const again = askTask("> ", term.input);
    await term.type("half typed\x03");
    assert.equal(await entered(again, "\x1b[A\r"), "say hi");
  });

  it("says how to quit at Ctrl+C on an empty prompt, and quits at the second, or at Ctrl+D", async () => {
    const { notices, stop } = collectNotices("To quit");
    try {
      const term = terminal();
      const answer = askTask("> ", term.input);
      await term.type("\x03");
      assert.equal(notices.length, 1);
      assert.match(notices[0], /To quit, press Ctrl\+C again, or Ctrl\+D, or type \/exit\./);
      await term.type("\x03");
      assert.equal(await answer, null);
      const next = askTask("> ", term.input);
      await term.type("\x04");
      assert.equal(await next, null);
      assert.equal(notices.length, 1);
    } finally {
      stop();
    }
  });

  it("answers a question with null at Ctrl+C, which stops the task", async () => {
    const term = terminal();
    const answer = ask("  Allow? [y]es / [n]o: ", undefined, term.input);
    await term.type("y\x03");
    assert.equal(await answer, null);
  });

  it("answers a question with null when the task stops meanwhile (at --time-limit), as at Ctrl+C, and reads on", async () => {
    const term = terminal();
    const task = new AbortController();
    const answer = ask("  Allow? [y]es / [n]o: ", task.signal, term.input);
    await term.type("y");
    task.abort("the time limit (--time-limit) was reached");
    assert.equal(await answer, null);
    assert.equal(term.raw(), false);
    assert.ok((await term.shown()).includes("\n\x1b[?2004l"), "on a line of its own, bracketed paste off");
    assert.equal(await ask("  Allow? [y]es / [n]o: ", task.signal, term.input), null, "already stopped");
    // Answered in time, a question lets go of the task's signal: stopping the task later leaves the next read alone.
    const later = new AbortController();
    const answered = ask("  Allow? [y]es / [n]o: ", later.signal, term.input);
    await term.type("y\r");
    assert.equal(await answered, "y");
    const next = askTask("> ", term.input);
    later.abort();
    await term.type("say hi\r");
    assert.equal(await next, "say hi");
  });

  it("redraws the prompt when the terminal is resized only while asking, not over a task's output", async () => {
    const term = terminal();
    const answer = askTask("> ", term.input);
    await term.type("say hi\r");
    await answer;
    const after = (await term.shown()).length;
    term.resize();
    assert.equal((await term.shown()).length, after);
    void askTask("> ", term.input);
    const asking = (await term.shown()).length;
    term.resize();
    assert.ok((await term.shown()).length > asking);
  });
});

describe("piped input", () => {
  it("gives each prompt the next line, however the lines arrive", async () => {
    const lines = new PassThrough();
    const from = new Input(lines as unknown as NodeJS.ReadStream, new PassThrough().resume() as unknown as NodeJS.WriteStream);
    lines.end("say hi\n/context\nsay bye");
    const read = [];
    for (let i = 0; i < 4; i++) read.push(await askTask("> ", from));
    assert.deepEqual(read, ["say hi", "/context", "say bye", null]);
  });

  it("answers a question with null when the task stops meanwhile, and still gives the next prompt the next line", async () => {
    const lines = new PassThrough();
    const from = new Input(lines as unknown as NodeJS.ReadStream, new PassThrough().resume() as unknown as NodeJS.WriteStream);
    const task = new AbortController();
    const answer = ask("Allow? ", task.signal, from);
    task.abort();
    assert.equal(await answer, null);
    lines.end("say hi\n");
    assert.deepEqual([await askTask("> ", from), await askTask("> ", from)], ["say hi", null]);
  });
});

describe("the input once its interface has closed", () => {
  /** Node 24 throws at pause() and resume() on a closed interface. Node 22 doesn't, so here it does too. */
  function asOnNode24(t: TestContext): void {
    for (const name of ["pause", "resume"] as const) {
      const method = readline.Interface.prototype[name];
      t.mock.method(readline.Interface.prototype, name, function (this: readline.Interface & { closed: boolean }) {
        if (this.closed) throw new Error("readline was closed");
        return method.call(this);
      });
    }
  }

  it("gives the terminal back at Ctrl+D, at the prompt or at a question, and reads on", async (t) => {
    asOnNode24(t);
    const term = terminal();
    for (const read of [() => askTask("> ", term.input), () => ask("  Allow? [y]es / [n]o: ", undefined, term.input)]) {
      const answer = read();
      await term.type("\x04");
      assert.equal(await answer, null);
      assert.equal(term.raw(), false);
      assert.ok((await term.shown()).endsWith("\x1b[?2004l"), "bracketed paste off");
    }
    const next = askTask("> ", term.input);
    await term.type("say hi\r");
    assert.equal(await next, "say hi");
  });

  it("reads the piped lines left after the input ends, and null when it ends while asking", async (t) => {
    asOnNode24(t);
    const piped = () => {
      const lines = new PassThrough();
      return { lines, from: new Input(lines as unknown as NodeJS.ReadStream, new PassThrough().resume() as unknown as NodeJS.WriteStream) };
    };
    const left = piped();
    left.lines.end("say hi\nsay bye");
    assert.deepEqual([await askTask("> ", left.from), await askTask("> ", left.from), await askTask("> ", left.from)], ["say hi", "say bye", null]);
    const asking = piped();
    const answer = askTask("> ", asking.from);
    asking.lines.end();
    assert.equal(await answer, null);
  });
});
