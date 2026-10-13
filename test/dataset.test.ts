import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { build, type Found } from "../bench/dataset.ts";
import type { ExportedSession } from "../src/export.ts";

const ROOT = join(import.meta.dirname, "..");

/** A finished conversation: the task, one bash call and its result, and the model's last reply. */
function session(command: string, reply = "Done."): ExportedSession {
  return {
    example: {
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Fix it." },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] },
        { role: "tool", tool_call_id: "c1", content: "ok\n\nExit code: 0" },
        { role: "assistant", content: reply },
      ],
    },
    redacted: 0,
    complete: true,
  };
}

describe("the training set", () => {
  const found = (task: string, session: string, suite = "evolve2"): Found => ({ suite, task, model: "deepseek-flash", run: "r", session });
  const sessions: Record<string, ExportedSession | undefined> = {
    short: session("ls"),
    long: session("ls", "Done. ".repeat(1000)),
    unfinished: undefined,
    invalid: { ...session("ls"), example: { messages: [{ role: "user", content: "Fix it." }, { role: "tool", tool_call_id: "x", content: "?" }, { role: "assistant", content: "Done." }] } },
    leak: session(`cat ${ROOT}/bench/evolve2/tasks/a/tests/test_hidden.py`),
    lookUp: session("curl https://raw.githubusercontent.com/laude-institute/terminal-bench/main/tasks/a/solution.sh"),
  };
  const options = { perTask: 2, maxTokens: 1000, heldOut: (_: string, task: string) => task === "b", load: (s: string) => sessions[s] };

  it("leaves out what can't be trained on, and says why", () => {
    const { train, left } = build(["short", "long", "unfinished", "invalid", "leak", "lookUp"].map((s) => found("a", s)), options);
    assert.equal(train.length, 1);
    assert.deepEqual(left, { "no finished reply": 1, "invalid order": 1, "reached the answers": 2, "too long": 1, "over the cap": 0 });
  });

  it("keeps each task's shortest, and puts a held-out task's examples only in the held-out set", () => {
    const medium = session("ls", "Done. ".repeat(40));
    const { train, heldOut, left } = build(
      [found("a", "short"), found("a", "medium"), found("a", "short"), found("b", "short"), found("b", "medium")],
      { ...options, load: (s) => (s === "medium" ? medium : sessions[s]) },
    );
    assert.deepEqual(train.map((e) => [e.task, e.tokens < 100]), [["a", true], ["a", true]], "the two short ones, not the medium");
    assert.deepEqual(heldOut.map((e) => e.task), ["b", "b"]);
    assert.equal(left["over the cap"], 1);
    assert.ok(train.every((e) => e.modelTokens > 0 && e.modelTokens < e.tokens));
  });
});
