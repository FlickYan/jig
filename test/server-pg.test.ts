import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { TLSSocket } from "node:tls";
import { Connection, parseUrl, Pool, redactUrl, Scram } from "../server/pg.ts";
import { openStore, type Store, type Task } from "../server/store.ts";
import { dropPostgresDatabases, NO_POSTGRES, POSTGRES_URL, postgresDatabase } from "./postgres.ts";

// The Postgres client (server/pg.ts): SCRAM against RFC 7677's example, the other logins and TLS against a
// stand-in server, and the rest against a real Postgres where JIG_TEST_POSTGRES_URL names one.

const FIXTURES = join(import.meta.dirname, "fixtures");
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await dropPostgresDatabases();
});

/** A pool closed after the test. */
function pool(url: string, options?: ConstructorParameters<typeof Pool>[1]): Pool {
  const made = new Pool(url, options);
  closers.push(() => made.close());
  return made;
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A message from the server: its type, then its length and body. */
function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.write(type);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const int32 = (...values: number[]) => Buffer.concat(values.map((value) => Buffer.from([value >>> 24, (value >> 16) & 255, (value >> 8) & 255, value & 255])));

/**
 * Enough of a Postgres server to log in to: it asks for the password in md5 or in clear, takes TLS (with
 * the fixtures' certificate for 127.0.0.1) or turns it away, and records the answers it got.
 */
async function standIn(auth: "md5" | "cleartext", tls: boolean): Promise<{ url: (password: string, query?: string) => string; answers: string[] }> {
  const salt = Buffer.from([1, 2, 3, 4]);
  const answers: string[] = [];
  const sockets = new Set<Socket>();
  const key = await readFile(join(FIXTURES, "k8s-api.key"));
  const cert = await readFile(join(FIXTURES, "k8s-api.crt"));
  const server: Server = createServer((raw) => {
    sockets.add(raw);
    let socket: Socket = raw;
    let buffer = Buffer.alloc(0);
    let user = "";
    let started = false;
    const read = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
          const length = buffer.readInt32BE(0);
          const code = buffer.readInt32BE(4);
          const fields = buffer.subarray(8, length).toString("utf8").split("\0");
          buffer = buffer.subarray(length);
          if (code === 80877103) {
            raw.write(tls ? "S" : "N");
            if (tls) {
              raw.off("data", read);
              socket = new TLSSocket(raw, { isServer: true, key, cert });
              socket.on("data", read);
              socket.on("error", () => {});
            }
            continue;
          }
          started = true;
          user = fields[fields.indexOf("user") + 1];
          socket.write(message("R", auth === "md5" ? Buffer.concat([int32(5), salt]) : int32(3)));
          continue;
        }
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
        const length = buffer.readInt32BE(1);
        const type = String.fromCharCode(buffer[0]);
        const body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);
        if (type === "X") socket.end();
        if (type !== "p") continue;
        const answer = body.toString("utf8", 0, body.length - 1);
        answers.push(answer);
        // md5's rule written out: "md5" + md5(md5(password + user) + salt).
        const inner = createHash("md5").update(`secret${user}`).digest("hex");
        const expected = auth === "md5" ? `md5${createHash("md5").update(inner).update(salt).digest("hex")}` : "secret";
        if (answer === expected) socket.write(Buffer.concat([message("R", int32(0)), message("K", int32(1234, 5678)), message("Z", Buffer.from("I"))]));
        else socket.end(message("E", Buffer.from(`SFATAL\0C28P01\0Mpassword authentication failed for user "${user}"\0\0`)));
      }
    };
    raw.on("data", read);
    raw.on("error", () => {});
    raw.on("close", () => sockets.delete(raw));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done) => server.close(done));
  });
  const { port } = server.address() as { port: number };
  return { url: (password, query = "") => `postgres://jig:${password}@127.0.0.1:${port}/jig${query}`, answers };
}

describe("the Postgres client", () => {
  it("computes SCRAM-SHA-256 as RFC 7677's example does, and checks the server's signature", () => {
    const scram = new Scram("pencil", "rOprNGfwEbeRWgbNEkqO", "user");
    assert.equal(scram.first(), "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
    const serverFirst = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
    assert.equal(scram.final(serverFirst), "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
    scram.verify("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
    assert.throws(() => scram.verify("v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="), /isn't the server it claims to be/);
    assert.throws(() => scram.verify("e=invalid-proof"), /refused the login: invalid-proof/);
    // A server whose nonce doesn't extend ours is someone else's answer.
    assert.throws(() => new Scram("pencil", "abc").final("r=xyz,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"), /nonce/);
  });

  it("reads a URL, and refuses what it doesn't know", () => {
    assert.deepEqual(parseUrl("postgres://jig:p%40ss@db.example.com:6543/tasks?sslmode=disable"), { host: "db.example.com", port: 6543, user: "jig", password: "p@ss", database: "tasks", tls: false, options: undefined });
    assert.deepEqual(parseUrl("postgresql://jig@[::1]/"), { host: "::1", port: 5432, user: "jig", password: "", database: "jig", tls: false, options: undefined });
    assert.deepEqual(parseUrl("postgres://jig:x@h/db?sslmode=require").tls, { ca: undefined });
    assert.throws(() => parseUrl("mysql://jig@h/db"), /must start postgres:\/\//);
    assert.throws(() => parseUrl("postgres://jig@h/db?sslmode=prefer"), /^Error: sslmode must be disable, require or verify-full \(both check the certificate\), not prefer$/);
    assert.deepEqual(parseUrl("postgres://jig:x@h/db?sslmode=verify-full").tls, { ca: undefined });
    assert.throws(() => parseUrl("postgres://jig@h/db?connect_timeout=5"), /connect_timeout isn't one this client knows/);
    assert.throws(() => parseUrl("postgres://h/db"), /names no user/);
  });

  it("hides a URL's password however it is written, a / or @ in it included", async () => {
    assert.equal(redactUrl("postgres://jig:secret@db:5432/jig?sslmode=require"), "postgres://jig:***@db:5432/jig?sslmode=require");
    assert.equal(redactUrl("postgres://jig:pa/ss@db/jig"), "postgres://jig:***@db/jig");
    assert.equal(redactUrl("postgres://jig:p@ss@db/jig"), "postgres://jig:***@db/jig");
    assert.equal(redactUrl("postgres://jig@db/jig"), "postgres://jig@db/jig");
    assert.equal(redactUrl("data/jig.db"), "data/jig.db");
    for (const url of ["postgres://jig:pa/ss@127.0.0.1:1/x", "postgres://jig:p@ss@127.0.0.1:1/x"]) {
      await assert.rejects(openStore(url), (err: Error) => {
        assert.ok(err.message.startsWith("Couldn't open the database postgres://jig:***@127.0.0.1:1/x: "), err.message);
        for (const part of ["pa/ss", "p@ss", "ss@"]) assert.ok(!err.message.includes(part), err.message);
        return true;
      });
    }
  });

  it("refuses a SCRAM login that the server ends without proving it knows the password", async () => {
    // A server that asks for SCRAM, answers the first message, then says the login is done without its proof.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      let buffer = Buffer.alloc(0);
      let started = false;
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (!started) {
            if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
            buffer = buffer.subarray(buffer.readInt32BE(0));
            started = true;
            socket.write(message("R", Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")])));
            continue;
          }
          if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
          const body = buffer.subarray(5, buffer.readInt32BE(1) + 1);
          buffer = buffer.subarray(body.length + 5);
          const text = body.toString("latin1");
          const nonce = /r=([^,]+)/.exec(text)?.[1] ?? "";
          if (text.startsWith("SCRAM-SHA-256")) socket.write(message("R", Buffer.concat([int32(11), Buffer.from(`r=${nonce}server,s=${Buffer.from("salt").toString("base64")},i=4096`)])));
          else socket.write(Buffer.concat([message("R", int32(0)), message("K", int32(1234, 5678)), message("Z", Buffer.from("I"))]));
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    closers.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => server.close(done));
    });
    const { port } = server.address() as { port: number };
    await assert.rejects(Connection.connect(parseUrl(`postgres://jig:secret@127.0.0.1:${port}/jig`)), /^Error: The database ended the SCRAM login without proving it knows the password$/);
  });

  it("logs in with md5 and with a cleartext password, and says when the password is wrong", async () => {
    for (const auth of ["md5", "cleartext"] as const) {
      const server = await standIn(auth, false);
      const connection = await Connection.connect(parseUrl(server.url("secret")));
      connection.end();
      await assert.rejects(Connection.connect(parseUrl(server.url("wrong"))), /password authentication failed for user "jig"/);
      assert.equal(server.answers.length, 2);
      if (auth === "md5") assert.ok(server.answers.every((answer) => /^md5[0-9a-f]{32}$/.test(answer)), "the password never goes in clear");
    }
  });

  it("gives up on a connection that none frees within acquireTimeoutMs, with an error a caller may retry", async () => {
    // A server that takes connections and never answers: the pool's one connection is never ready.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    closers.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => server.close(done));
    });
    const url = `postgres://jig:secret@127.0.0.1:${(server.address() as { port: number }).port}/jig`;
    for (const [options, ms] of [[{ acquireTimeoutMs: 300 }, 300], [{ queryTimeoutMs: 400 }, 400]] as const) {
      const db = pool(url, { max: 1, connectTimeoutMs: 1500, ...options });
      const first = db.query("SELECT 1").then(() => undefined, (err: Error) => err);
      const began = Date.now();
      const second = db.query("SELECT 2").then(() => undefined, (err: Error) => err);
      assert.deepEqual(db.stats(), { open: 1, idle: 0, waiting: 1 });
      const err = await second;
      const waited = Date.now() - began;
      assert.ok(waited >= ms - 20 && waited < 1500, `waited ${waited} ms`);
      // Not a PgError, which the scheduler would take for one not worth trying again.
      assert.equal(err?.constructor, Error);
      assert.equal(err?.message, `no database connection was free within ${ms} ms (pool max 1)`);
      assert.deepEqual(db.stats(), { open: 1, idle: 0, waiting: 0 });
      // The first gives up once its connection hasn't logged in within connectTimeoutMs.
      assert.ok((await first) instanceof Error);
      assert.deepEqual(db.stats(), { open: 0, idle: 0, waiting: 0 });
    }
  });

  it("with sslmode=require, speaks TLS only to a server whose certificate it can check", async () => {
    const server = await standIn("cleartext", true);
    const connection = await Connection.connect(parseUrl(server.url("secret", `?sslmode=require&sslrootcert=${join(FIXTURES, "k8s-api.crt")}`)));
    connection.end();
    assert.deepEqual(server.answers, ["secret"]);
    // The system's CAs didn't sign it: the password isn't sent.
    await assert.rejects(Connection.connect(parseUrl(server.url("secret", "?sslmode=require"))), /self.signed|unable to verify/i);
    assert.deepEqual(server.answers, ["secret"]);
    const plain = await standIn("cleartext", false);
    await assert.rejects(Connection.connect(parseUrl(plain.url("secret", "?sslmode=require"))), /doesn't take TLS connections/);
  });
});

describe("the Postgres client, on a real Postgres", { skip: NO_POSTGRES }, () => {
  const url = POSTGRES_URL!;
  const marker = () => `jig-test-${randomBytes(4).toString("hex")}`;
  /** The pid of the backend running a query that holds this text. */
  const backendOf = (admin: Pool, text: string) =>
    until(async () => (await admin.query("SELECT pid FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()", [`%${text}%`])).rows[0]?.pid as number | undefined, `a backend running ${text}`);

  it("logs in with SCRAM-SHA-256 and decodes what it reads by type", async () => {
    const db = pool(url);
    const [row] = (
      await db.query("SELECT $1::int AS int, $2::bigint AS big, $3::text AS text, $4::bool AS yes, $5::json AS json, $6::jsonb AS jsonb, $7::timestamptz AS time, NULL::text AS none, 1.5::float8 AS float", [
        42,
        "9007199254740991",
        "héllo, 'world'",
        true,
        { a: [1, "two"] },
        { b: null },
        new Date("2026-11-04T10:20:30.456Z"),
      ])
    ).rows;
    assert.deepEqual(row, { int: 42, big: 9007199254740991, text: "héllo, 'world'", yes: true, json: { a: [1, "two"] }, jsonb: { b: null }, time: new Date("2026-11-04T10:20:30.456Z"), none: null, float: 1.5 });
    await assert.rejects(db.query("SELECT * FROM no_such_table"), (err: Error & { code?: string }) => err.code === "42P01" && /no_such_table/.test(err.message));
    // An error leaves the connection usable.
    assert.equal((await db.query("SELECT 1 AS one")).rows[0].one, 1);
  });

  it("says when the password is wrong, without showing it", async () => {
    const wrong = new URL(url);
    wrong.password = "not-the-password";
    await assert.rejects(pool(wrong.toString()).query("SELECT 1"), /password authentication failed/);
    await assert.rejects(openStore(wrong.toString()), (err: Error) => /^Couldn't open the database postgres:\/\/[^:]+:\*\*\*@/.test(err.message) && !err.message.includes("not-the-password"));
  });

  it("runs a transaction's statements on one connection: committed, or rolled back if it throws", async () => {
    const db = pool(await postgresDatabase());
    await db.simple("CREATE TABLE t (n integer)");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO t VALUES (1)");
        throw new Error("changed its mind");
      }),
      /changed its mind/,
    );
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (2)");
      await tx.query("INSERT INTO t VALUES (3)");
    });
    assert.deepEqual((await db.query("SELECT n FROM t ORDER BY n")).rows, [{ n: 2 }, { n: 3 }]);
  });

  it("opens no more connections than its most, and queries wait for one", async () => {
    const db = pool(url, { max: 2 });
    const pids = await Promise.all(Array.from({ length: 6 }, async () => (await db.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.05)")).rows[0].pid));
    assert.equal(new Set(pids).size, 2);
  });

  it("lets a query wait for a connection held by another only acquireTimeoutMs, and the next gets it once it is free", async () => {
    const db = pool(url, { max: 1, acquireTimeoutMs: 300 });
    const holding = db.query("SELECT pg_sleep(1)");
    await until(() => db.stats().open === 1, "the first query's connection");
    await assert.rejects(db.query("SELECT 1"), /^Error: no database connection was free within 300 ms \(pool max 1\)$/);
    await holding;
    assert.deepEqual(db.stats(), { open: 1, idle: 1, waiting: 0 });
    assert.equal((await db.query("SELECT 2 AS two")).rows[0].two, 2);
  });

  it("stops the timer of a query that got its connection in time, so it can't drop another that waits", async () => {
    const db = pool(url, { max: 1, acquireTimeoutMs: 1500 });
    const first = db.query("SELECT pg_sleep(0.2)");
    const began = Date.now();
    // The second waits for the first, gets its connection at about 0.2 s, and holds it past its 1.5 s.
    const second = db.query("SELECT pg_sleep(1.6)");
    assert.equal(db.stats().waiting, 1);
    await first;
    await new Promise((done) => setTimeout(done, began + 1000 - Date.now()));
    assert.deepEqual(db.stats(), { open: 1, idle: 0, waiting: 0 });
    // The third waits from 1 s, past the second's 1.5 s, and gets the connection at about 1.8 s: well before
    // its own time runs out, at 2.5 s.
    const third = db.query("SELECT 3 AS three");
    assert.equal(db.stats().waiting, 1);
    assert.equal((await third).rows[0].three, 3);
    await second;
    assert.deepEqual(db.stats(), { open: 1, idle: 1, waiting: 0 });
  });

  it("drops a connection lost mid-query, and the next query gets another", async () => {
    const db = pool(url, { max: 1 });
    const admin = pool(url);
    const mark = marker();
    // Caught at once: the query can fail while the terminate is still being answered, before it is awaited.
    const sleeping = db.query(`SELECT pg_sleep(30), '${mark}'`).then(() => undefined, (err: Error) => err);
    const pid = await backendOf(admin, mark);
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    assert.match(String((await sleeping)?.message), /terminating connection|connection to the database was lost/);
    assert.notEqual((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid);
  });

  it("cancels a query past its time, and the next query goes on", async () => {
    const db = pool(url, { queryTimeoutMs: 200 });
    const admin = pool(url);
    const mark = marker();
    await assert.rejects(db.query(`SELECT pg_sleep(30), '${mark}'`), /took over 200 ms/);
    assert.equal((await db.query("SELECT 2 AS two")).rows[0].two, 2);
    // The server stopped it too.
    await until(async () => (await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE query LIKE $1 AND state = 'active' AND pid <> pg_backend_pid()", [`%${mark}%`])).rows[0].n === 0, "the server to stop the query");
  });

  it("has the server end a transaction left idle, so a replica that froze holding the claims' lock lets it go", async () => {
    assert.equal((await pool(url).query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout, "1min");
    const key = randomInt(2 ** 40);
    const frozen = pool(url, { idleInTransactionMs: 500 });
    let thaw!: () => void;
    const thawed = new Promise<void>((done) => (thaw = done));
    let locked = false;
    const holding = frozen.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [key]);
      locked = true;
      await thawed;
    });
    holding.catch(() => {});
    await until(() => locked, "the lock to be taken");
    const began = Date.now();
    await pool(url, { queryTimeoutMs: 5000 }).transaction((tx) => tx.query("SELECT pg_advisory_xact_lock($1)", [key]));
    assert.ok(Date.now() - began < 3000, `waited ${Date.now() - began} ms`);
    // The frozen one's transaction is gone: it can't commit what it did.
    thaw();
    await assert.rejects(holding);
  });

  it("listens again after its connection is lost, and hears what comes after", async () => {
    const db = pool(url);
    const admin = pool(url);
    const channel = `jig_test_${randomBytes(4).toString("hex")}`;
    const listener = db.listen([channel]);
    await listener.ready;
    const heard: string[] = [];
    listener.on("notification", (name: string, payload: string) => name === channel && heard.push(payload));
    await admin.query("SELECT pg_notify($1, 'before')", [channel]);
    await until(() => heard.length === 1, "the first notification");
    const pid = await backendOf(admin, `LISTEN "${channel}"`);
    const reconnected = new Promise((done) => listener.once("connected", done));
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await until(() => !listener.live, "the listener to notice");
    await reconnected;
    assert.equal(listener.live, true);
    await admin.query("SELECT pg_notify($1, 'after')", [channel]);
    await until(() => heard.length === 2, "the notification after it came back");
    assert.deepEqual(heard, ["before", "after"]);
  });
});

describe("the Postgres store, on a real Postgres", { skip: NO_POSTGRES }, () => {
  it("sizes its pool by the options openStore is given, and pings the database", async () => {
    const store = await openStore(await postgresDatabase(), { pool: { max: 1, acquireTimeoutMs: 5000 } });
    closers.push(() => store.close());
    await Promise.all([store.ping!(), store.ping!(), store.ping!()]);
    assert.deepEqual(store.poolStats!(), { open: 1, idle: 1, waiting: 0 });
    const sqlite = await openStore(":memory:");
    closers.push(() => sqlite.close());
    await sqlite.ping!();
    assert.equal(sqlite.poolStats, undefined);
  });

  it("takes only max and acquireTimeoutMs from openStore's pool, and keeps the default max for one left undefined", async () => {
    // A library caller's object may hold more than the config allows, or an explicit undefined.
    const options = { max: undefined, acquireTimeoutMs: 5000, queryTimeoutMs: 0, idleInTransactionMs: 0 };
    const store = await openStore(await postgresDatabase(), { pool: options });
    closers.push(() => store.close());
    const db = (store as unknown as { pool: Pool }).pool;
    // 15 at once: the default 10 open, and the rest wait.
    const slow = Array.from({ length: 15 }, () => db.query("SELECT pg_sleep(0.3)"));
    await until(() => store.poolStats!().waiting === 5, "five queries to wait");
    assert.deepEqual(store.poolStats!(), { open: 10, idle: 0, waiting: 5 });
    await Promise.all(slow);
    // The server still ends a session left idle in a transaction: twice the default 30 s query timeout.
    assert.equal((await db.query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout, "1min");
  });

  it("reads a task's events a page at a time, and all of them without a limit", async () => {
    const store = await openStore(await postgresDatabase());
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "x", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    for (let seq = 1; seq <= 250; seq++) await store.addEvent(task.id, seq, { v: 1, seq, ts: "", type: "text" });
    const seqs = async (after: number, limit?: number) => (await store.events(task.id, after, limit)).map((row) => row.seq);
    assert.deepEqual(await seqs(0, 100), Array.from({ length: 100 }, (_, i) => i + 1));
    assert.deepEqual(await seqs(100, 100), Array.from({ length: 100 }, (_, i) => i + 101));
    assert.deepEqual(await seqs(200, 100), Array.from({ length: 50 }, (_, i) => i + 201));
    assert.equal((await seqs(0)).length, 250);
  });

  it("lists tasks in several statuses and counts a tenant's standing as the SQLite store does", async () => {
    const stores = [await openStore(await postgresDatabase()), await openStore(":memory:")];
    // A task's cost is counted on the day it ended, by the clock: so the tasks are made by it too.
    const now = new Date();
    const seen: unknown[] = [];
    for (const store of stores) {
      closers.push(() => store.close());
      await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
      // Numbered in their prompts, as the ids differ from store to store.
      const tasks: Task[] = [];
      for (let i = 0; i < 12; i++) tasks.push((await store.createTask("a", { prompt: String(i), maxSteps: 5, timeLimit: 60, model: "deepseek-flash" }, { now })) as Task);
      for (const task of tasks.filter((_, i) => i % 3 === 0)) await store.cancelQueued(task.id);
      const claimed = (await store.claim("a", { owner: "r1", leaseMs: 60_000, concurrency: 1, tenantConcurrency: 1 })) as Task;
      await store.finish(claimed.id, "r1", { status: "succeeded", exitCode: 0, stop: "done", error: null, stats: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.25 });
      const prompts = async (options: Parameters<Store["tasks"]>[1]) => (await store.tasks("a", { ...options, prompts: true })).map((task) => Number(task.spec.prompt));
      const page = await prompts({ status: ["queued", "cancelled"], limit: 4 });
      const second = await store.tasks("a", { status: ["queued", "cancelled"], limit: 4, before: tasks[page.at(-1)!].id, prompts: true });
      seen.push([page, second.map((task) => Number(task.spec.prompt)), await prompts({ status: ["succeeded", "cancelled", "error"] }), await store.standing("a", now), await store.standing("a", new Date("2100-01-01T00:00:00Z"))]);
    }
    assert.deepEqual(seen[0], seen[1]);
    assert.deepEqual(seen[1], [[11, 10, 9, 8], [7, 6, 5, 4], [9, 6, 3, 1, 0], { queued: 7, running: 0, tasksToday: 12, usdToday: 0.25, usdThisMonth: 0.25 }, { queued: 7, running: 0, tasksToday: 0, usdToday: 0, usdThisMonth: 0 }]);
  });

  it("stops a page of a task's events once their JSON comes to the bytes asked for, in UTF-8", async () => {
    const store = await openStore(await postgresDatabase());
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "x", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // "é" is a character, and two bytes in UTF-8.
    const event = (seq: number) => ({ v: 1, seq, ts: "", type: "text", text: "é".repeat(1000) });
    for (let seq = 1; seq <= 10; seq++) await store.addEvent(task.id, seq, event(seq));
    const size = Buffer.byteLength(JSON.stringify(event(1)));
    const seqs = async (after: number, limit: number, bytes: number) => (await store.events(task.id, after, limit, bytes)).map((row) => row.seq);
    assert.deepEqual(await seqs(0, 100, 3 * size), [1, 2, 3]);
    assert.deepEqual(await seqs(0, 100, 3 * size + 1), [1, 2, 3, 4]);
    assert.deepEqual(await seqs(2, 100, 1), [3]);
    assert.deepEqual(await seqs(0, 2, 100 * size), [1, 2]);
    assert.deepEqual(await seqs(7, 100, 100 * size), [8, 9, 10]);
  });

  // A spec is stored as it came, and a JSON operator over one that holds "\u0000" anywhere is an error
  // (22P05): the ledger, written in the statement that ends a task, once read the model that way.
  const LIMITS = { concurrency: 5, maxSteps: 5, timeLimit: 60, budgetUsd: null };
  const PLAIN = { prompt: "x", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" };
  const WITH_NUL = { ...PLAIN, workspace: { files: { "a.bin": "x\u0000y" } } };
  const TERMS = { owner: "r1", leaseMs: 60_000, concurrency: 10, tenantConcurrency: 10 };
  const OUTCOME = { status: "succeeded" as const, exitCode: 0, stop: "end_turn", error: null, stats: null, usage: { input: 3, cacheRead: 0, cacheWrite: 0, output: 2 }, cost: 0.25 };
  const byModel = { from: "2000-01-01", to: "2999-12-31", group: ["model" as const] };

  it("finishes and cancels a task whose files hold a NUL, with its model in the ledger", async () => {
    const store = await openStore(await postgresDatabase());
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    const run = await store.createTask("a", WITH_NUL);
    const queued = await store.createTask("a", WITH_NUL);
    assert.equal(((await store.claim("a", TERMS)) as { id: string }).id, run.id);
    assert.equal(await store.finish(run.id, "r1", OUTCOME), true);
    assert.equal(await store.cancelQueued(queued.id), true);
    assert.deepEqual((await store.task(run.id))!.spec.workspace, WITH_NUL.workspace);
    assert.deepEqual((await store.tasks("a")).map((task) => task.status), ["cancelled", "succeeded"]);
    const [row, ...rest] = await store.usage(byModel);
    assert.deepEqual(rest, []);
    assert.deepEqual({ model: row.model, tasks: row.tasks, input: row.input, output: row.output }, { model: "deepseek-flash", tasks: 2, input: 3, output: 2 });
  });

  it("keeps a finished task's result, and lists it only with the prompts", async () => {
    const store = await openStore(await postgresDatabase());
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    const run = await store.createTask("a", PLAIN);
    assert.deepEqual([run.result, run.resultTruncated], [null, false]);
    await store.claim("a", TERMS);
    assert.equal(await store.finish(run.id, "r1", { ...OUTCOME, result: "done: fixed app.py", resultTruncated: true }), true);
    const ended = (await store.task(run.id))!;
    assert.deepEqual([ended.status, ended.result, ended.resultTruncated], ["succeeded", "done: fixed app.py", true]);
    const [full] = await store.tasks("a", { prompts: true });
    assert.deepEqual([full.spec.prompt, full.result, full.resultTruncated], ["x", "done: fixed app.py", true]);
    const [listed] = await store.tasks("a");
    assert.deepEqual([listed.spec.prompt, listed.result, listed.resultTruncated], ["", null, false]);
  });

  it("answers a create whose key the tenant used with the task it made, and whether its body was the same", async () => {
    const store = await openStore(await postgresDatabase());
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    await store.putTenant({ id: "b", limits: LIMITS }, []);
    const now = new Date();
    const made = await store.createTask("a", PLAIN, { now }, { key: "k", hash: "h1" });
    assert.ok("id" in made);
    assert.deepEqual(await store.createTask("a", PLAIN, { now }, { key: "k", hash: "h1" }), { replay: made, same: true });
    assert.deepEqual(await store.createTask("a", PLAIN, { now }, { key: "k", hash: "h2" }), { replay: made, same: false });
    // Before the caps: the replay is answered though the queue is full, and a refusal records nothing.
    assert.deepEqual(await store.createTask("a", PLAIN, { now, maxQueued: 1 }, { key: "k", hash: "h1" }), { replay: made, same: true });
    assert.deepEqual(await store.createTask("a", PLAIN, { now, maxQueued: 1 }, { key: "k2", hash: "h1" }), { quota: "maxQueued", limit: 1, used: 1 });
    const second = await store.createTask("a", PLAIN, { now }, { key: "k2", hash: "h1" });
    assert.ok("id" in second && second.id !== made.id);
    // Another tenant's key, and the same one once its 24 hours are over, make tasks of their own.
    const theirs = await store.createTask("b", PLAIN, { now }, { key: "k", hash: "h1" });
    assert.ok("id" in theirs && theirs.tenant === "b");
    const later = await store.createTask("a", PLAIN, { now: new Date(now.getTime() + 24 * 3600_000) }, { key: "k", hash: "h1" });
    assert.ok("id" in later && later.id !== made.id);
    assert.equal((await store.tasks("a")).length, 3);
  });

  it("ends every tenant's lapsed tasks though one tenant's holds a NUL", async () => {
    const store = await openStore(await postgresDatabase());
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    await store.putTenant({ id: "b", limits: LIMITS }, []);
    const bad = await store.createTask("a", WITH_NUL);
    const other = await store.createTask("b", PLAIN);
    // Leases that ran out a second before they were given.
    for (const tenant of ["a", "b"]) await store.claim(tenant, { ...TERMS, leaseMs: -1000 });
    assert.deepEqual((await store.expire("its replica is gone")).sort(), [bad.id, other.id].sort());
    assert.equal((await store.task(other.id))!.status, "error");
    assert.equal((await store.task(bad.id))!.status, "error");
    assert.deepEqual(await store.inStatus("running"), []);
  });

  it("cancels the queued tasks of a tenant removed from the config though one holds a NUL", async () => {
    const store = await openStore(await postgresDatabase());
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    await store.putTenant({ id: "gone", limits: LIMITS }, []);
    const kept = await store.createTask("a", PLAIN);
    const bad = await store.createTask("gone", WITH_NUL);
    const plain = await store.createTask("gone", PLAIN);
    assert.equal(await store.retireTenants(["a"]), 2);
    assert.deepEqual([(await store.task(bad.id))!.status, (await store.task(plain.id))!.status, (await store.task(kept.id))!.status], ["cancelled", "cancelled", "queued"]);
  });

  it("reads the model from the spec of a task that a replica of the version before made, and forgets old keys", async () => {
    const url = await postgresDatabase();
    const store = await openStore(url);
    closers.push(() => store.close());
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    const old = await store.createTask("a", PLAIN);
    const nul = await store.createTask("a", WITH_NUL);
    const db = pool(url);
    {
      // As the version before inserts: no model column.
      await db.query("UPDATE tasks SET model = NULL");
      assert.equal(await store.cancelQueued(old.id), true);
      assert.equal(await store.cancelQueued(nul.id), true);
      assert.deepEqual((await store.usage(byModel)).map((row) => [row.model, row.tasks]).sort(), [["", 1], ["deepseek-flash", 1]]);
      // A key is deleted once its day is over, whoever's it is, and holds until then.
      const now = new Date();
      const made = await store.createTask("a", PLAIN, { now }, { key: "k", hash: "h" });
      assert.ok("id" in made);
      assert.equal(await store.forgetKeys(new Date(now.getTime() + 24 * 3600_000 - 1)), 0);
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM idempotency")).rows[0].n), 1);
      assert.equal(await store.forgetKeys(new Date(now.getTime() + 24 * 3600_000)), 1);
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM idempotency")).rows[0].n), 0);
    }
  });

  it("moves a database on whose tasks already hold a NUL or half a surrogate pair, and ends them", async () => {
    const url = await postgresDatabase();
    await (await openStore(url)).close();
    const db = pool(url);
    // As schema 5 left it: no model column, the model in the spec alone (nor the result's and the table of
    // Idempotency-Keys, which came after).
    await db.query("ALTER TABLE tasks DROP COLUMN model, DROP COLUMN result, DROP COLUMN result_truncated");
    await db.query("DROP TABLE idempotency");
    await db.query("UPDATE jig_schema SET version = 5");
    await db.query("INSERT INTO tenants (id, limits) VALUES ('a', $1)", [JSON.stringify(LIMITS)]);
    const insert = (id: string, spec: object, status: string) => db.query("INSERT INTO tasks (id, tenant, prompt, spec, status, created, started) VALUES ($1, 'a', 'x', $2, $3, now(), now())", [id, JSON.stringify(spec), status]);
    const { prompt: _, ...plain } = PLAIN;
    const nul = { ...plain, workspace: WITH_NUL.workspace };
    await insert("task_1", plain, "queued");
    await insert("task_2", nul, "queued");
    await insert("task_3", nul, "running");
    await insert("task_4", plain, "running");
    // Half a surrogate pair, which the API let through in a file's contents: ->> refuses that escape too.
    const lone = { ...plain, workspace: { files: { "a.txt": "x\ud800y" } } };
    await insert("task_5", lone, "queued");
    await insert("task_6", lone, "running");
    // Escapes the operator reads; the backfill passes these by all the same, as it looks for "\u" alone.
    await insert("task_7", { ...plain, workspace: { files: { "a.txt": "x\u0001y" } } }, "queued");
    const store = await openStore(url);
    closers.push(() => store.close());
    assert.equal((await db.query("SELECT version FROM jig_schema")).rows[0].version, 9);
    // The model of a spec that holds one can't be read in SQL: it is left out, and its ledger row has none.
    assert.deepEqual((await db.query("SELECT id, model FROM tasks ORDER BY id")).rows, [
      { id: "task_1", model: "deepseek-flash" },
      { id: "task_2", model: null },
      { id: "task_3", model: null },
      { id: "task_4", model: "deepseek-flash" },
      { id: "task_5", model: null },
      { id: "task_6", model: null },
      { id: "task_7", model: null },
    ]);
    for (const id of ["task_1", "task_2", "task_5", "task_7"]) assert.equal(await store.cancelQueued(id), true);
    assert.deepEqual((await store.expire("its replica is gone")).sort(), ["task_3", "task_4", "task_6"]);
    assert.deepEqual((await store.task("task_3"))!.spec.workspace, WITH_NUL.workspace);
    assert.deepEqual((await store.task("task_6"))!.spec.workspace, lone.workspace);
    const rows = await store.usage(byModel);
    assert.deepEqual(rows.map((row) => [row.model, row.tasks]).sort(), [["", 5], ["deepseek-flash", 2]]);
  });

  it("opens a database whose purged column and index were made by hand, ahead of the upgrade", async () => {
    const url = await postgresDatabase();
    await (await openStore(url)).close();
    const db = pool(url);
    // As schema 8 left it, then the two statements docs/server.md gives for a large table.
    await db.query("DROP INDEX tasks_unpurged");
    await db.query("ALTER TABLE tasks DROP COLUMN purged");
    await db.query("UPDATE jig_schema SET version = 8");
    await db.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS purged timestamptz");
    await db.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_unpurged ON tasks (ended) WHERE purged IS NULL AND ended IS NOT NULL");
    const store = await openStore(url);
    closers.push(() => store.close());
    assert.equal((await db.query("SELECT version FROM jig_schema")).rows[0].version, 9);
    assert.deepEqual((await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid = 'tasks_unpurged'::regclass")).rows, [{ indisvalid: true }]);
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    const task = await store.createTask("a", PLAIN);
    assert.equal(await store.cancelQueued(task.id), true);
    assert.equal((await store.purge(task.id))!.first, true);
  });

  it("purges tasks whose stored spec holds a NUL or half a surrogate pair, one by its id and the rest by their age", async () => {
    const url = await postgresDatabase();
    const store = await openStore(url);
    closers.push(() => store.close());
    const db = pool(url);
    await store.putTenant({ id: "a", limits: LIMITS }, []);
    // Inserted as an older version let them in: the API refuses a NUL in a file now.
    const { prompt: _, ...plain } = PLAIN;
    const specs = { task_1: { ...plain, workspace: WITH_NUL.workspace }, task_2: { ...plain, workspace: WITH_NUL.workspace }, task_3: { ...plain, workspace: { files: { "a.txt": "x\ud800y" } } } };
    for (const [id, spec] of Object.entries(specs)) {
      await db.query("INSERT INTO tasks (id, tenant, prompt, spec, model, status, created, started, ended) VALUES ($1, 'a', 'the prompt', $2, 'deepseek-flash', 'succeeded', now(), now(), now() - interval '1 hour')", [id, JSON.stringify(spec)]);
      await store.addEvent(id, 1, { v: 1, seq: 1, ts: "", type: "text", text: "said\u0000" });
    }
    const slim = { prompt: "", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" };
    const purged = (await store.purge("task_1"))!;
    assert.deepEqual([purged.first, purged.task.spec], [true, slim]);
    // Retried while another test file's purge holds the database's lock.
    assert.equal(await until(() => store.purgeEnded(60_000, 10), "the rest to be purged"), 2);
    for (const id of Object.keys(specs)) assert.deepEqual([(await store.task(id))!.spec, await store.events(id)], [slim, []]);
    assert.deepEqual((await db.query("SELECT spec::text AS spec FROM tasks WHERE id = 'task_3'")).rows, [{ spec: JSON.stringify(plain) }]);
  });
});
