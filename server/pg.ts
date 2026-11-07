import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

// A small Postgres client, with no dependencies: enough of the wire protocol (version 3) for the task
// service's store. A URL (postgres://user:password@host:port/db?sslmode=disable|require), startup and
// authentication (SCRAM-SHA-256, md5, a cleartext password, or none), queries with $1, $2 ... parameters
// over the extended protocol in text format, the results' common types decoded, transactions, a small
// pool, and LISTEN/NOTIFY on a connection of its own that comes back after it is lost.

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** TLS, its certificate checked against these CAs (the system's when undefined); false for none. */
  tls: false | { ca?: string };
  /** Startup options (libpq's `options`: "-c search_path=x"). */
  options?: string;
}

/** A URL's settings: postgres://user:password@host:port/db?sslmode=disable|require&sslrootcert=<file>&options=... */
export function parseUrl(url: string): PgConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The database URL isn't one: postgres://user:password@host:port/database");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error(`The database URL must start postgres://, not ${parsed.protocol}//`);
  const query = Object.fromEntries(parsed.searchParams);
  const unknown = Object.keys(query).find((key) => !["sslmode", "sslrootcert", "options"].includes(key));
  if (unknown) throw new Error(`The database URL's ${unknown} isn't one this client knows (sslmode, sslrootcert, options)`);
  const sslmode = query.sslmode ?? "disable";
  // require checks the certificate, as libpq's verify-full does: a TLS connection to anyone is no better than none.
  if (!["disable", "require", "verify-full"].includes(sslmode)) throw new Error(`sslmode must be disable, require or verify-full (both check the certificate), not ${sslmode}`);
  const user = decodeURIComponent(parsed.username);
  if (!user) throw new Error("The database URL names no user");
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, "$1") || "localhost",
    port: Number(parsed.port || 5432),
    user,
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)) || user,
    tls: sslmode === "disable" ? false : { ca: query.sslrootcert && readFileSync(query.sslrootcert, "utf8") },
    options: query.options,
  };
}

/**
 * The URL with its password hidden, for a message: everything from the user's first ":" to the last "@",
 * so a password with a raw "/" or "@" in it, which the URL parser misreads, stays out too.
 */
export function redactUrl(url: string): string {
  const start = url.indexOf("://") + 3;
  const at = url.lastIndexOf("@");
  const colon = url.indexOf(":", start);
  if (start < 3 || at < start || colon < 0 || colon > at) return url;
  return `${url.slice(0, colon)}:***@${url.slice(at + 1)}`;
}

/** An error the server sent, with its SQLSTATE code. */
export class PgError extends Error {
  code: string;
  detail?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? "the database reported an error");
    this.code = fields.C ?? "";
    this.detail = fields.D;
  }
}

export type Row = Record<string, unknown>;
export interface Result {
  rows: Row[];
  /** What the command's tag says it did: rows updated, inserted, deleted or selected. */
  rowCount: number;
}

/** SCRAM-SHA-256 (RFC 5802 and 7677), the client's side; Postgres ignores the user name in it. */
export class Scram {
  private password: string;
  private nonce: string;
  private bare: string;
  private serverSignature?: Buffer;

  constructor(password: string, nonce = randomBytes(18).toString("base64"), user = "") {
    // Not SASLprep'd: an ASCII password comes out of it the same, and Postgres uses the password as it is
    // when it can't prepare it.
    this.password = password;
    this.nonce = nonce;
    this.bare = `n=${user.replaceAll("=", "=3D").replaceAll(",", "=2C")},r=${nonce}`;
  }

  /** The client-first message: no channel binding. */
  first(): string {
    return `n,,${this.bare}`;
  }

  /** The client-final message, for the server-first one. */
  final(serverFirst: string): string {
    const fields = attributes(serverFirst);
    if (!fields.r?.startsWith(this.nonce) || fields.r.length === this.nonce.length) throw new Error("The database's SCRAM nonce doesn't extend ours");
    const iterations = Number(fields.i);
    if (!fields.s || !Number.isInteger(iterations) || iterations < 1) throw new Error("The database's SCRAM message has no salt or iteration count");
    const salted = pbkdf2Sync(this.password, Buffer.from(fields.s, "base64"), iterations, 32, "sha256");
    const clientKey = hmac(salted, "Client Key");
    const withoutProof = `c=biws,r=${fields.r}`;
    const auth = `${this.bare},${serverFirst},${withoutProof}`;
    const signature = hmac(createHash("sha256").update(clientKey).digest(), auth);
    const proof = Buffer.from(clientKey.map((byte, i) => byte ^ signature[i]));
    this.serverSignature = hmac(hmac(salted, "Server Key"), auth);
    return `${withoutProof},p=${proof.toString("base64")}`;
  }

  /** Throws unless the server-final message proves the server knew the password too. */
  verify(serverFinal: string): void {
    const fields = attributes(serverFinal);
    if (fields.e) throw new Error(`The database refused the login: ${fields.e}`);
    const signature = Buffer.from(fields.v ?? "", "base64");
    if (!this.serverSignature || signature.length !== 32 || !timingSafeEqual(signature, this.serverSignature)) throw new Error("The database's SCRAM signature is wrong: it isn't the server it claims to be");
  }
}

function attributes(message: string): Record<string, string> {
  return Object.fromEntries(message.split(",").map((part) => [part.slice(0, 1), part.slice(2)]));
}

function hmac(key: Buffer, text: string): Buffer {
  return createHmac("sha256", key).update(text).digest();
}

/** md5 authentication's answer: "md5" + md5(md5(password + user) + salt), in hex. */
export function md5Password(user: string, password: string, salt: Buffer): string {
  const inner = createHash("md5").update(password + user).digest("hex");
  return `md5${createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex")}`;
}

// The types the results are decoded to, by oid; the others stay text.
const TIMESTAMP = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)(?:([+-]\d\d)(?::?(\d\d))?)?$/;
const PARSERS: Record<number, (text: string) => unknown> = {
  16: (text) => text === "t",
  20: Number, // bigint, exact to 2^53
  21: Number,
  23: Number,
  26: Number,
  700: Number,
  701: Number,
  114: (text) => JSON.parse(text),
  3802: (text) => JSON.parse(text),
  1114: parseTimestamp,
  1184: parseTimestamp,
};

/** A timestamp in the ISO DateStyle; one without a zone is UTC, which the connection's TimeZone is. */
function parseTimestamp(text: string): Date | string {
  const match = TIMESTAMP.exec(text);
  return match ? new Date(`${match[1]}T${match[2]}${match[3] ? `${match[3]}:${match[4] ?? "00"}` : "Z"}`) : text;
}

/** A parameter's text: objects and arrays go as JSON, dates as ISO times. */
function encode(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Buffer.from(value.toISOString());
  if (typeof value === "boolean") return Buffer.from(value ? "t" : "f");
  if (typeof value === "object") return Buffer.from(JSON.stringify(value));
  return Buffer.from(String(value));
}

/** Builds a message: a type byte (none for the startup ones), its length, then its fields. */
class Out {
  private parts: Buffer[] = [];
  str(text: string): this {
    this.parts.push(Buffer.from(`${text}\0`));
    return this;
  }
  i16(n: number): this {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(n);
    this.parts.push(buffer);
    return this;
  }
  i32(n: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(n);
    this.parts.push(buffer);
    return this;
  }
  bytes(buffer: Buffer): this {
    this.parts.push(buffer);
    return this;
  }
  build(type?: string): Buffer {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(type ? 5 : 4);
    if (type) head.write(type);
    head.writeInt32BE(body.length + 4, type ? 1 : 0);
    return Buffer.concat([head, body]);
  }
}

/** Reads a message's fields in order. */
class In {
  private at = 0;
  private buffer: Buffer;
  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }
  i16(): number {
    return this.buffer.readInt16BE((this.at += 2) - 2);
  }
  i32(): number {
    return this.buffer.readInt32BE((this.at += 4) - 4);
  }
  str(): string {
    const end = this.buffer.indexOf(0, this.at);
    const text = this.buffer.toString("utf8", this.at, end);
    this.at = end + 1;
    return text;
  }
  bytes(n: number): Buffer {
    return this.buffer.subarray(this.at, (this.at += n));
  }
  rest(): Buffer {
    return this.buffer.subarray(this.at);
  }
}

/** The fields of an ErrorResponse, by their one-letter codes (S severity, C code, M message, D detail). */
function errorFields(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let at = 0; at < body.length && body[at] !== 0; ) {
    const end = body.indexOf(0, at + 1);
    fields[String.fromCharCode(body[at])] = body.toString("utf8", at + 1, end);
    at = end + 1;
  }
  return fields;
}

/** What a query in flight is collecting, until the server is ready again. */
interface Pending {
  fields: { name: string; type: number }[];
  rows: Row[];
  rowCount: number;
  error?: Error;
  done(error: Error | undefined, result: Result): void;
}

const LOST = "the connection to the database was lost";

/** One connection to the server. The pool's users take it a query at a time. */
export class Connection extends EventEmitter {
  /** Set once the connection can't be used again: it closed, failed, or was left mid-transaction. */
  broken = false;
  /** The server's transaction status after the last query: I (idle), T (in one) or E (in a failed one). */
  status = "I";
  private socket: Socket;
  private gone = false;
  private pending?: Pending;
  private chunks: Buffer[] = [];
  private size = 0;
  /** Bytes needed before the next message can be read whole. */
  private need = 5;
  private key?: { pid: number; secret: number };
  private config: PgConfig;
  /** Startup's handler of messages, until the connection is ready. */
  private starting?: (type: string, body: Buffer) => void;

  private constructor(socket: Socket, config: PgConfig) {
    super();
    this.socket = socket;
    this.config = config;
  }

  /** Connects, logs in and waits for the server to be ready; `parameters` are settings for its session. */
  static async connect(config: PgConfig, timeoutMs = 10_000, parameters: Record<string, string> = {}): Promise<Connection> {
    let socket = netConnect({ host: config.host, port: config.port });
    const timer = setTimeout(() => socket.destroy(new Error(`Couldn't connect to the database at ${config.host}:${config.port} within ${timeoutMs} ms`)), timeoutMs);
    try {
      await new Promise<void>((done, fail) => socket.once("connect", done).once("error", fail));
      if (config.tls) socket = await startTls(socket, config);
      socket.setNoDelay(true);
      // A dead peer is noticed even on a connection that only listens.
      socket.setKeepAlive(true, 10_000);
      const connection = new Connection(socket, config);
      await connection.startup(parameters);
      return connection;
    } catch (err) {
      socket.destroy();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private startup(settings: Record<string, string>): Promise<void> {
    const { user, password, database, options } = this.config;
    const socket = this.socket;
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    socket.on("error", () => {}); // what failed comes to "close"
    socket.on("close", () => this.lost());
    return new Promise<void>((done, fail) => {
      let scram: Scram | undefined;
      let verified = false;
      const closed = () => fail(new Error(`${LOST} while logging in`));
      this.once("close", closed);
      this.starting = (type, body) => {
        if (type === "E") return fail(new PgError(errorFields(body)));
        if (type === "K") this.key = { pid: body.readInt32BE(0), secret: body.readInt32BE(4) };
        if (type === "Z") {
          this.starting = undefined;
          this.off("close", closed);
          return done();
        }
        if (type !== "R") return;
        const reader = new In(body);
        const code = reader.i32();
        try {
          // Logged in; but a SCRAM login isn't over until the server has proved it knows the password too.
          if (code === 0) {
            if (scram && !verified) throw new Error("The database ended the SCRAM login without proving it knows the password");
            return;
          }
          if (code === 3) return void socket.write(new Out().str(password).build("p"));
          if (code === 5) return void socket.write(new Out().str(md5Password(user, password, reader.bytes(4))).build("p"));
          if (code === 10) {
            const mechanisms: string[] = [];
            for (let name; (name = reader.str()); ) mechanisms.push(name);
            if (!mechanisms.includes("SCRAM-SHA-256")) throw new Error(`The database wants a login this client can't do: ${mechanisms.join(", ")}`);
            scram = new Scram(password);
            const first = Buffer.from(scram.first());
            return void socket.write(new Out().str("SCRAM-SHA-256").i32(first.length).bytes(first).build("p"));
          }
          if (code === 11 && scram) return void socket.write(new Out().bytes(Buffer.from(scram.final(reader.rest().toString("utf8")))).build("p"));
          if (code === 12 && scram) {
            scram.verify(reader.rest().toString("utf8"));
            verified = true;
            return;
          }
          throw new Error(`The database wants a login this client can't do (authentication ${code})`);
        } catch (err) {
          fail(err);
        }
      };
      // The session's times in UTC and ISO, which the timestamps are decoded from.
      const parameters = { ...settings, user, database, client_encoding: "UTF8", TimeZone: "UTC", DateStyle: "ISO, MDY", application_name: "jig", ...(options && { options }) };
      const out = new Out().i32(196608);
      for (const [name, value] of Object.entries(parameters)) out.str(name).str(value);
      socket.write(out.str("").build());
    });
  }

  private read(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size < this.need) return;
    // Joined only once a whole message is there, so a large result isn't copied over and over.
    const buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    let at = 0;
    while (buffer.length - at >= 5) {
      const length = buffer.readInt32BE(at + 1);
      if (buffer.length - at < length + 1) break;
      this.message(String.fromCharCode(buffer[at]), buffer.subarray(at + 5, at + 1 + length));
      at += length + 1;
    }
    const rest = buffer.subarray(at);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    this.need = rest.length >= 5 ? rest.readInt32BE(1) + 1 : 5;
  }

  private message(type: string, body: Buffer): void {
    if (type === "A") {
      const reader = new In(body);
      reader.i32();
      const channel = reader.str();
      this.emit("notification", channel, reader.str());
      return;
    }
    if (type === "N" || type === "S") return; // notices, and parameters the server reports
    if (this.starting) return this.starting(type, body);
    const pending = this.pending;
    if (type === "E") {
      const fields = errorFields(body);
      // A FATAL error (the server shutting down, or the backend terminated) ends the connection.
      if (["FATAL", "PANIC"].includes(fields.S ?? "")) this.broken = true;
      if (pending) pending.error ??= new PgError(fields);
      return;
    }
    if (!pending) return;
    if (type === "T") {
      const reader = new In(body);
      pending.fields = [];
      for (let n = reader.i16(); n > 0; n--) {
        const name = reader.str();
        reader.bytes(6);
        const type = reader.i32();
        reader.bytes(8);
        pending.fields.push({ name, type });
      }
    } else if (type === "D") {
      const reader = new In(body);
      const row: Row = {};
      const count = reader.i16();
      for (let i = 0; i < count; i++) {
        const length = reader.i32();
        const field = pending.fields[i];
        if (length < 0) row[field.name] = null;
        else {
          const text = reader.bytes(length).toString("utf8");
          const parse = PARSERS[field.type];
          row[field.name] = parse ? parse(text) : text;
        }
      }
      pending.rows.push(row);
    } else if (type === "C") {
      const tag = body.toString("utf8", 0, body.length - 1);
      pending.rowCount = Number(/ (\d+)$/.exec(tag)?.[1] ?? 0);
    } else if (type === "Z") {
      this.status = String.fromCharCode(body[0]);
      this.pending = undefined;
      pending.done(pending.error, { rows: pending.rows, rowCount: pending.rowCount });
    }
    // The rest (ParseComplete, BindComplete, NoData, EmptyQueryResponse) say nothing a caller needs.
  }

  private lost(): void {
    if (this.gone) return;
    this.gone = true;
    this.broken = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.done(pending.error ?? new Error(LOST), { rows: [], rowCount: 0 });
    this.emit("close");
  }

  /** Runs one statement with its $n parameters; a query past `timeoutMs` is cancelled and the connection dropped. */
  query(text: string, params: unknown[] = [], timeoutMs = 0): Promise<Result> {
    const bind = new Out().str("").str("").i16(0).i16(params.length);
    for (const value of params) {
      const encoded = encode(value);
      if (encoded === null) bind.i32(-1);
      else bind.i32(encoded.length).bytes(encoded);
    }
    bind.i16(0);
    const messages = [
      new Out().str("").str(text).i16(0).build("P"),
      bind.build("B"),
      new Out().bytes(Buffer.from("P")).str("").build("D"),
      new Out().str("").i32(0).build("E"),
      new Out().build("S"),
    ];
    return this.send(Buffer.concat(messages), timeoutMs);
  }

  /** Runs statements in the simple protocol (DDL, LISTEN), with no parameters. */
  simple(text: string, timeoutMs = 0): Promise<Result> {
    return this.send(new Out().str(text).build("Q"), timeoutMs);
  }

  private send(bytes: Buffer, timeoutMs: number): Promise<Result> {
    if (this.broken) return Promise.reject(new Error(LOST));
    if (this.pending) return Promise.reject(new Error("The connection is running another query"));
    return new Promise<Result>((done, fail) => {
      const timer =
        timeoutMs > 0 &&
        setTimeout(() => {
          // The server is asked to stop the query, and the connection, whose state is unknown now, is dropped.
          this.cancel();
          this.pending?.done(new Error(`The database query took over ${timeoutMs} ms`), { rows: [], rowCount: 0 });
          this.pending = undefined;
          this.destroy();
        }, timeoutMs);
      this.pending = {
        fields: [],
        rows: [],
        rowCount: 0,
        done: (error, result) => {
          if (timer) clearTimeout(timer);
          if (error) fail(error);
          else done(result);
        },
      };
      this.socket.write(bytes);
    });
  }

  /** Asks the server, on a connection of its own, to cancel what this one is running. */
  private cancel(): void {
    if (!this.key) return;
    const request = new Out().i32(80877102).i32(this.key.pid).i32(this.key.secret).build();
    const socket = netConnect({ host: this.config.host, port: this.config.port }, () => socket.end(request));
    socket.on("error", () => {});
    socket.setTimeout(5_000, () => socket.destroy());
  }

  /** Ends the session politely. */
  end(): void {
    if (this.broken) return;
    this.broken = true;
    this.socket.end(new Out().build("X"));
  }

  destroy(): void {
    this.broken = true;
    this.socket.destroy();
  }
}

/** Asks the server for TLS and starts it, the certificate checked against the CAs and the host's name. */
async function startTls(socket: Socket, config: PgConfig): Promise<Socket> {
  socket.write(new Out().i32(80877103).build());
  const answer = await new Promise<string>((done, fail) => {
    socket.once("data", (data: Buffer) => done(data.toString("latin1", 0, 1)));
    socket.once("error", fail);
    socket.once("close", () => fail(new Error(LOST)));
  });
  if (answer !== "S") throw new Error(`The database at ${config.host}:${config.port} doesn't take TLS connections (sslmode=require)`);
  const ca = config.tls ? config.tls.ca : undefined;
  const secure = tlsConnect({ socket, host: config.host, servername: isIP(config.host) ? undefined : config.host, ca, rejectUnauthorized: true });
  await new Promise<void>((done, fail) => secure.once("secureConnect", done).once("error", fail));
  return secure;
}

export interface PoolOptions {
  /** The most connections open at once (default 10). */
  max?: number;
  /** How long an unused connection stays open, in milliseconds (default 30 s). */
  idleMs?: number;
  /** How long a query may take before it is cancelled, in milliseconds (default 30 s; 0 for no limit). */
  queryTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * How long the server lets a transaction sit idle before it ends the session, in milliseconds (default
   * twice queryTimeoutMs; 0 for no limit): a client that froze or was cut off mid-transaction lets go of
   * its locks then, not when the server's TCP keepalive notices, hours later.
   */
  idleInTransactionMs?: number;
  /**
   * How long a query waits for a connection when all `max` are in use, in milliseconds (default the
   * smaller of queryTimeoutMs and 10 s, or 10 s with no query timeout; 0 for no limit): past it, it fails
   * as a query that took too long does, so its caller's own deadline holds.
   */
  acquireTimeoutMs?: number;
}

/** A pool's connections: open (in use or idle, or opening), idle, and the queries waiting for one. */
export interface PoolStats {
  open: number;
  idle: number;
  waiting: number;
}

/** A query waiting for a connection, and its timer. */
interface Waiter {
  done: (connection: Connection) => void;
  fail: (err: unknown) => void;
  timer?: NodeJS.Timeout;
}

/** What a transaction's function gets: its connection's queries. */
export interface Client {
  query(text: string, params?: unknown[]): Promise<Result>;
}

/**
 * A pool of connections: a query takes one, or waits for one, and gives it back after. A connection that
 * broke, or was left in a transaction, is closed instead of given back, and the next query opens another.
 */
export class Pool implements Client {
  readonly config: PgConfig;
  private options: Required<PoolOptions>;
  private idle: { connection: Connection; timer: NodeJS.Timeout }[] = [];
  private open = 0;
  private waiting: Waiter[] = [];
  private listeners = new Set<Listener>();
  private closed = false;

  constructor(url: string | PgConfig, options: PoolOptions = {}) {
    this.config = typeof url === "string" ? parseUrl(url) : url;
    const queryTimeoutMs = options.queryTimeoutMs ?? 30_000;
    const acquireTimeoutMs = queryTimeoutMs > 0 ? Math.min(queryTimeoutMs, 10_000) : 10_000;
    this.options = { max: 10, idleMs: 30_000, queryTimeoutMs, connectTimeoutMs: 10_000, idleInTransactionMs: 2 * queryTimeoutMs, acquireTimeoutMs, ...options };
  }

  stats(): PoolStats {
    return { open: this.open, idle: this.idle.length, waiting: this.waiting.length };
  }

  async query(text: string, params: unknown[] = []): Promise<Result> {
    const connection = await this.take();
    try {
      return await connection.query(text, params, this.options.queryTimeoutMs);
    } finally {
      this.give(connection);
    }
  }

  /** Runs `body` in a transaction on one connection: committed if it returns, rolled back if it throws. */
  async transaction<T>(body: (client: Client) => Promise<T>): Promise<T> {
    const connection = await this.take();
    const timeout = this.options.queryTimeoutMs;
    try {
      await connection.query("BEGIN", [], timeout);
      const result = await body({ query: (text, params = []) => connection.query(text, params, timeout) });
      await connection.query("COMMIT", [], timeout);
      return result;
    } catch (err) {
      if (!connection.broken) await connection.query("ROLLBACK", [], timeout).catch(() => {});
      throw err;
    } finally {
      this.give(connection);
    }
  }

  /** Runs statements in the simple protocol: a migration's DDL, say. */
  async simple(text: string): Promise<void> {
    const connection = await this.take();
    try {
      await connection.simple(text, this.options.queryTimeoutMs);
    } finally {
      this.give(connection);
    }
  }

  /** A connection of its own that listens on these channels, and comes back when it is lost. */
  listen(channels: string[]): Listener {
    const listener = new Listener(this.config, channels, this.options.connectTimeoutMs);
    this.listeners.add(listener);
    listener.once("closed", () => this.listeners.delete(listener));
    return listener;
  }

  private async take(): Promise<Connection> {
    if (this.closed) throw new Error("The database's pool is closed");
    for (let entry; (entry = this.idle.pop()); ) {
      clearTimeout(entry.timer);
      if (!entry.connection.broken) return entry.connection;
      this.open--;
    }
    if (this.open >= this.options.max) return this.wait();
    return this.connect();
  }

  /**
   * Waits for a connection another query gives back, for acquireTimeoutMs at most. The error is a plain
   * one, not a PgError: the database refused nothing, so a caller that tries again may do so.
   */
  private wait(): Promise<Connection> {
    const { acquireTimeoutMs, max } = this.options;
    return new Promise((done, fail) => {
      const waiter: Waiter = { done, fail };
      if (acquireTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          fail(new Error(`no database connection was free within ${acquireTimeoutMs} ms (pool max ${max})`));
        }, acquireTimeoutMs);
      }
      this.waiting.push(waiter);
    });
  }

  /** The query that has waited longest for a connection, no longer timed. */
  private nextWaiter(): Waiter | undefined {
    const waiter = this.waiting.shift();
    clearTimeout(waiter?.timer);
    return waiter;
  }

  private async connect(): Promise<Connection> {
    this.open++;
    try {
      const { connectTimeoutMs, idleInTransactionMs } = this.options;
      return await Connection.connect(this.config, connectTimeoutMs, idleInTransactionMs > 0 ? { idle_in_transaction_session_timeout: String(idleInTransactionMs) } : {});
    } catch (err) {
      this.open--;
      throw err;
    }
  }

  private give(connection: Connection): void {
    if (connection.broken || connection.status !== "I" || this.closed) {
      this.open--;
      connection.destroy();
      // One that was waiting for this connection gets a new one.
      const waiter = this.nextWaiter();
      if (waiter) this.connect().then(waiter.done, waiter.fail);
      return;
    }
    const waiter = this.nextWaiter();
    if (waiter) return waiter.done(connection);
    const entry = {
      connection,
      timer: setTimeout(() => {
        this.idle.splice(this.idle.indexOf(entry), 1);
        this.open--;
        connection.end();
      }, this.options.idleMs).unref(),
    };
    this.idle.push(entry);
  }

  /** Closes the connections not in use (those in use close as they come back) and the listeners. */
  async close(): Promise<void> {
    this.closed = true;
    for (const { connection, timer } of this.idle.splice(0)) {
      clearTimeout(timer);
      this.open--;
      connection.end();
    }
    for (let waiter; (waiter = this.nextWaiter()); ) waiter.fail(new Error("The database's pool is closed"));
    await Promise.all([...this.listeners].map((listener) => listener.close()));
  }
}

/**
 * LISTEN on a connection of its own. Emits "notification" (channel, payload), and "connected" each time it
 * is listening again after it was lost, as notifications sent meanwhile are missed: whoever listens should
 * look at what changed. `live` says whether it is listening now.
 */
export class Listener extends EventEmitter {
  live = false;
  private connection?: Connection;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private config: PgConfig;
  private channels: string[];
  private connectTimeoutMs: number;
  /** Settles once the first connection is listening, or has failed. */
  readonly ready: Promise<void>;

  constructor(config: PgConfig, channels: string[], connectTimeoutMs: number) {
    super();
    this.config = config;
    this.channels = channels;
    this.connectTimeoutMs = connectTimeoutMs;
    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    const connection = await Connection.connect(this.config, this.connectTimeoutMs);
    connection.on("notification", (channel: string, payload: string) => this.emit("notification", channel, payload));
    try {
      await connection.simple(this.channels.map((channel) => `LISTEN "${channel.replaceAll('"', '""')}"`).join("; "));
    } catch (err) {
      connection.destroy();
      throw err;
    }
    if (this.closed || connection.broken) return connection.end();
    this.connection = connection;
    connection.once("close", () => this.lost());
    this.live = true;
    this.emit("connected");
  }

  /** Connects again after a pause that grows, from 100 ms to 5 s, while the server can't be reached. */
  private lost(delay = 100): void {
    this.live = false;
    this.connection = undefined;
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.connect().then(
        () => this.connection || this.closed || this.lost(Math.min(delay * 2, 5_000)),
        () => this.lost(Math.min(delay * 2, 5_000)),
      );
    }, delay);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.live = false;
    clearTimeout(this.timer);
    await this.ready.catch(() => {});
    this.connection?.end();
    this.emit("closed");
  }
}
