import { randomBytes } from "node:crypto";
import { Pool } from "../server/pg.ts";

// The tests that need a Postgres take its URL from JIG_TEST_POSTGRES_URL, and skip without one. Each
// database they ask for is a schema of its own in it, dropped after the test, so test files running at
// once don't meet.

export const POSTGRES_URL = process.env.JIG_TEST_POSTGRES_URL;
/** node:test's skip for a test that needs Postgres: false, or the reason. */
export const NO_POSTGRES = POSTGRES_URL ? false : "JIG_TEST_POSTGRES_URL isn't set: these need a Postgres database to use";

const made: string[] = [];

/** A new, empty schema in the test database, and a URL whose connections use it. */
export async function postgresDatabase(): Promise<string> {
  if (!POSTGRES_URL) throw new Error(NO_POSTGRES as string);
  const schema = `jig_test_${randomBytes(6).toString("hex")}`;
  const pool = new Pool(POSTGRES_URL);
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await pool.close();
  }
  made.push(schema);
  const url = new URL(POSTGRES_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

/** Drops the schemas postgresDatabase made, with everything in them. */
export async function dropPostgresDatabases(): Promise<void> {
  if (!made.length || !POSTGRES_URL) return;
  const pool = new Pool(POSTGRES_URL);
  try {
    for (const schema of made.splice(0)) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.close();
  }
}
