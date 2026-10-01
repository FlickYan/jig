import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Attempt, estimateCost, parseTranscript, summarize } from "../bench/metrics.ts";

const TRANSCRIPT = `I'll look at the pager first.
● read_file pager.py
       1\t"""Split search results into pages."""
● edit_file pager.py
  - return total // per_page
  + x
  ✗ old_string was not found in pager.py.
● edit_file pager.py
  Edited pager.py: replaced 1 line at line 9 with 1 line.
● bash python3 -m unittest
  OK
Fixed both bugs.
4 steps · 12.1k tokens in (9.6k from cache) · 842 out · 21.3s
`;

describe("parseTranscript", () => {
  it("counts tool calls and failures, and reads the summary line", () => {
    assert.deepEqual(parseTranscript(TRANSCRIPT), {
      steps: 4,
      tokensIn: 12100,
      cacheRead: 9600,
      tokensOut: 842,
      toolCalls: { read_file: 1, edit_file: 2, bash: 1 },
      toolErrors: 1,
      toolErrorsByTool: { edit_file: 1 },
    });
  });

  it("copes with colors and with a run that never finished", () => {
    assert.equal(parseTranscript(`\x1b[36m●\x1b[39m \x1b[1mbash\x1b[22m ls\n`).toolCalls.bash, 1);
    assert.equal(parseTranscript("API error 401: invalid key").steps, null);
  });
});

describe("estimateCost", () => {
  it("prices cached input separately", () => {
    // deepseek-flash: 2,500 uncached at $0.30/M + 9,600 cached at $0.006/M + 842 out at $1.20/M
    assert.equal(estimateCost("deepseek-flash", { tokensIn: 12100, cacheRead: 9600, tokensOut: 842 }), 0.00182);
    assert.equal(estimateCost("some-other-model", { tokensIn: 1, cacheRead: 0, tokensOut: 1 }), null);
  });
});

describe("summarize", () => {
  const attempt = (task: string, n: number, passed: boolean, steps: number): Attempt => ({
    task, attempt: n, passed, timedOut: false, seconds: 10, steps, tokensIn: 1000, cacheRead: 0, tokensOut: 100,
    cost: 0.01, toolCalls: { bash: 2 }, toolErrors: passed ? 0 : 1,
  });

  it("averages per attempt and measures the spread between rounds", () => {
    const s = summarize([attempt("a", 1, true, 4), attempt("b", 1, true, 6), attempt("a", 2, true, 4), attempt("b", 2, false, 10)]);
    assert.equal(s.passRate, 0.75);
    assert.equal(s.passRateSpread, 0.25); // round 1: 100%, round 2: 50%
    assert.equal(s.steps, 6);
    assert.equal(s.toolCalls, 2);
    assert.equal(s.toolErrors, 0.25);
  });
});
