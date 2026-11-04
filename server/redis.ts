// A minimal Redis client (RESP2), for the gateway's shared state: no dependencies, one connection, commands
// as arrays. Commands are pipelined (each is written at once, and the replies come back in the order they
// went), scripts go by EVALSHA with EVAL when Redis doesn't have them yet, and an error reply rejects its
// command's promise. A lost connection rejects what was in flight, since there is no knowing whether it
// ran; for a backoff time after (50 ms, doubling to 2 s) commands fail at once, then the next one connects
// again. A client that subscribes to channels reconnects by itself and subscribes again.
//
//   redis://[[username]:password@]host[:port][/db], or rediss:// for TLS

import { createHash } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** An error reply from Redis: its text, as Redis gave it ("ERR ...", "NOSCRIPT ...", "WRONGPASS ..."). */
export class RedisError extends Error {
  override name = "RedisError";
}

/** A reply: a simple or bulk string, an integer, null (a null bulk string or array), an error inside an array, or an array. */
export type RedisReply = string | number | null | RedisError | RedisReply[];

export interface RedisUrl {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db: number;
}

export function parseRedisUrl(url: string): RedisUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") throw new Error(`Not a redis:// or rediss:// URL: ${parsed.protocol}`);
  const db = parsed.pathname.replace(/^\//, "");
  if (db && !/^\d+$/.test(db)) throw new Error(`The database in a Redis URL is a number, not ${db}.`);
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
    port: Number(parsed.port || 6379),
    tls: parsed.protocol === "rediss:",
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number(db || 0),
  };
}

/** A command as Redis reads it: an array of bulk strings. */
export function encodeCommand(args: (string | number)[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const text = String(arg);
    parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
  }
  return Buffer.from(parts.join(""));
}

/** The reply that starts at `at` in `buffer`, and where it ends; undefined while it hasn't all arrived. */
export function parseReply(buffer: Buffer, at = 0): [RedisReply, number] | undefined {
  const end = buffer.indexOf("\r\n", at);
  if (end < 0) return undefined;
  const line = buffer.toString("utf8", at + 1, end);
  const next = end + 2;
  switch (buffer[at]) {
    case 0x2b: // +
      return [line, next];
    case 0x2d: // -
      return [new RedisError(line), next];
    case 0x3a: // :
      return [Number(line), next];
    case 0x24: {
      // $
      const length = Number(line);
      if (length < 0) return [null, next];
      if (buffer.length < next + length + 2) return undefined;
      return [buffer.toString("utf8", next, next + length), next + length + 2];
    }
    case 0x2a: {
      // *
      const count = Number(line);
      if (count < 0) return [null, next];
      const items: RedisReply[] = [];
      let position = next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buffer, position);
        if (!item) return undefined;
        items.push(item[0]);
        position = item[1];
      }
      return [items, position];
    }
    default:
      throw new Error(`Not a Redis reply: ${JSON.stringify(buffer.toString("utf8", at, Math.min(end, at + 40)))}`);
  }
}

/** A Lua script, sent by its SHA-1 once Redis has it. */
export interface RedisScript {
  source: string;
  sha: string;
}

export function redisScript(source: string): RedisScript {
  return { source, sha: createHash("sha1").update(source).digest("hex") };
}

export interface RedisOptions {
  /** How long a command may wait for its reply, connecting included (default: 2 seconds). */
  timeoutMs?: number;
  /** A message on a channel this client subscribed to. */
  onMessage?(channel: string, message: string): void;
}

interface Pending {
  args: (string | number)[];
  resolve(reply: RedisReply): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
}

const FIRST_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 2000;

export class Redis {
  private readonly url: RedisUrl;
  private readonly timeoutMs: number;
  private readonly onMessage?: (channel: string, message: string) => void;
  private state: "idle" | "connecting" | "ready" | "down" | "closed" = "idle";
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  /** Written, waiting for their replies, in order. */
  private readonly sent: Pending[] = [];
  /** Waiting for the connection. */
  private readonly queued: Pending[] = [];
  private readonly channels = new Set<string>();
  private lastError = new Error("Redis is not connected");
  private backoff = 0;
  private retry?: NodeJS.Timeout;

  constructor(url: string, options: RedisOptions = {}) {
    this.url = parseRedisUrl(url);
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.onMessage = options.onMessage;
  }

  /** Sends a command; resolves with its reply, or rejects with a RedisError reply or a connection's failure. */
  command(args: (string | number)[]): Promise<RedisReply> {
    return new Promise((resolve, reject) => {
      if (this.state === "closed") return reject(new Error("The Redis client is closed."));
      if (this.state === "down") return reject(this.lastError);
      const pending: Pending = { args, resolve, reject };
      // A reply this late means the connection is stuck: it goes, and what waited on it fails with it.
      pending.timer = setTimeout(() => this.fail(new Error(`Redis did not answer within ${this.timeoutMs} ms.`)), this.timeoutMs).unref();
      if (this.state === "ready") this.write(pending);
      else {
        this.queued.push(pending);
        if (this.state === "idle") this.connect();
      }
    });
  }

  /** Runs a script by its SHA-1, sending its source only when Redis doesn't have it (after a restart, say). */
  async eval(script: RedisScript, keys: string[], args: (string | number)[]): Promise<RedisReply> {
    try {
      return await this.command(["EVALSHA", script.sha, keys.length, ...keys, ...args]);
    } catch (err) {
      if (!(err instanceof RedisError && err.message.startsWith("NOSCRIPT"))) throw err;
      return this.command(["EVAL", script.source, keys.length, ...keys, ...args]);
    }
  }

  /** Subscribes to `channel`, now and after every reconnection; this connection then serves only subscriptions. */
  async subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
    if (this.state === "ready") await this.command(["SUBSCRIBE", channel]);
    else if (this.state === "idle") this.connect();
  }

  close(): void {
    this.state = "closed";
    clearTimeout(this.retry);
    this.socket?.destroy();
    this.socket = undefined;
    const err = new Error("The Redis client is closed.");
    for (const pending of [...this.sent.splice(0), ...this.queued.splice(0)]) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private connect(): void {
    this.state = "connecting";
    const { host, port, tls } = this.url;
    const socket = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on(tls ? "secureConnect" : "connect", () => this.handshake(socket));
    socket.on("data", (chunk: Buffer) => socket === this.socket && this.read(chunk));
    socket.on("error", (err) => socket === this.socket && this.fail(err));
    socket.on("close", () => socket === this.socket && this.fail(new Error("The connection to Redis closed.")));
  }

  /** AUTH, SELECT and SUBSCRIBE before anything else; if one fails, so does the connection. */
  private handshake(socket: Socket): void {
    const { username, password, db } = this.url;
    const steps: (string | number)[][] = [];
    if (password) steps.push(username ? ["AUTH", username, password] : ["AUTH", password]);
    if (db) steps.push(["SELECT", db]);
    for (const channel of this.channels) steps.push(["SUBSCRIBE", channel]);
    this.state = "ready";
    let left = steps.length;
    if (!left) this.backoff = 0;
    for (const args of steps) {
      this.write({
        args,
        resolve: () => {
          if (--left === 0) this.backoff = 0;
        },
        reject: (err) => socket === this.socket && this.fail(new Error(`Redis refused ${args[0]}: ${err.message}`)),
      });
    }
    for (const pending of this.queued.splice(0)) this.write(pending);
  }

  private write(pending: Pending): void {
    this.sent.push(pending);
    this.socket!.write(encodeCommand(pending.args));
  }

  private read(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let at = 0;
    for (;;) {
      let parsed: [RedisReply, number] | undefined;
      try {
        parsed = parseReply(this.buffer, at);
      } catch (err) {
        return this.fail(err as Error);
      }
      if (!parsed) break;
      const [reply, next] = parsed;
      at = next;
      if (this.channels.size && Array.isArray(reply) && reply[0] === "message") {
        this.onMessage?.(String(reply[1]), String(reply[2]));
        continue;
      }
      const pending = this.sent.shift();
      if (!pending) return this.fail(new Error("Redis sent a reply nothing asked for."));
      clearTimeout(pending.timer);
      if (reply instanceof RedisError) pending.reject(reply);
      else pending.resolve(reply);
      if (this.state !== "ready") return; // the reply failed the connection (a refused AUTH)
    }
    this.buffer = this.buffer.subarray(at);
  }

  /** The connection is lost: what was sent or waiting fails, and commands fail at once until the backoff is over. */
  private fail(err: Error): void {
    if (this.state === "closed" || this.state === "down") return;
    this.lastError = err;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.state = "down";
    for (const pending of [...this.sent.splice(0), ...this.queued.splice(0)]) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff ? this.backoff * 2 : FIRST_BACKOFF_MS);
    this.retry = setTimeout(() => {
      // A subscriber connects again by itself; a client that only sends connects at its next command.
      if (this.channels.size) this.connect();
      else this.state = "idle";
    }, this.backoff).unref();
  }
}
