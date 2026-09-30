/**
 * Calls `fn(item, index)` for every item, with at most `limit` calls running at the same time.
 * Resolves to the results in the same order as `items`, however long each call takes. Rejects with
 * the first error, without starting any more calls. Throws a RangeError if `limit` is not a positive
 * integer.
 */
export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const results = new Array(items.length);
  let next = 0;
  let failed = false;

  async function worker() {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
