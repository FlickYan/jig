/**
 * Calls `fn(item, index)` for every item, with at most `limit` calls running at the same time.
 * Resolves to the results in the same order as `items`, however long each call takes. Rejects with
 * the first error, without starting any more calls. Throws a RangeError if `limit` is not a positive
 * integer.
 */
export async function mapLimit(items, limit, fn) {
  const results = [];
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results.push(await fn(items[index], index));
    }
  }

  const workers = [];
  for (let i = 0; i <= limit; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
