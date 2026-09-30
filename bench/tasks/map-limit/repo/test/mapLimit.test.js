import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "../src/mapLimit.js";

test("maps every item", async () => {
  assert.deepEqual(await mapLimit([1, 2, 3], 1, async (x) => x * 2), [2, 4, 6]);
});
