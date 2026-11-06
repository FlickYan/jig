import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { TLSSocket } from "node:tls";
import { Connection, parseUrl, Pool, redactUrl, Scram } from "../server/pg.ts";
import { openStore } from "../server/store.ts";
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

  it("drops a connection lost mid-query, and the next query gets another", async () => {
    const db = pool(url, { max: 1 });
    const admin = pool(url);
    const mark = marker();
    const sleeping = db.query(`SELECT pg_sleep(30), '${mark}'`);
    const pid = await backendOf(admin, mark);
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await assert.rejects(sleeping, /terminating connection|connection to the database was lost/);
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
});
