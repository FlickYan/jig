import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "../src/mapLimit.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("results keep the order of the items", async () => {
  const delays = [40, 5, 25, 1, 15];
  assert.deepEqual(await mapLimit(delays, 3, async (ms, i) => (await sleep(ms), i)), [0, 1, 2, 3, 4]);
});

test("never runs more than `limit` calls at once", async () => {
  let running = 0;
  let most = 0;
  await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    running++;
    most = Math.max(most, running);
    await sleep(5);
    running--;
  });
  assert.equal(most, 3);
});

test("works when the limit is larger than the list", async () => {
  assert.deepEqual(await mapLimit([1, 2], 10, async (x) => x + 1), [2, 3]);
  assert.deepEqual(await mapLimit([], 2, async (x) => x), []);
});

test("rejects with the first error and starts nothing after it", async () => {
  const started = [];
  const run = mapLimit([0, 1, 2, 3, 4, 5], 1, async (x) => {
    started.push(x);
    if (x === 2) throw new Error("boom");
    return x;
  });
  await assert.rejects(run, /boom/);
  await sleep(20);
  assert.deepEqual(started, [0, 1, 2]);
});

test("a limit that is not a positive integer is a RangeError", async () => {
  // Thrown right away or as a rejected promise: the documentation's "throws" allows either.
  for (const limit of [0, -1, 1.5, "2"]) {
    await assert.rejects(async () => mapLimit([1], limit, async (x) => x), RangeError);
  }
});
