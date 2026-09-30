import { mapLimit } from "./mapLimit.js";

/** Fetches every URL, four at a time, and returns the response bodies in the same order. */
export function fetchAll(urls, fetcher = fetch) {
  return mapLimit(urls, 4, async (url) => (await fetcher(url)).text());
}
