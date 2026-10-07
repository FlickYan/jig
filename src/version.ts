import { readFileSync } from "node:fs";

/** jig's version, from package.json: one directory up from src/ when run from a clone, and from dist/ when installed. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
