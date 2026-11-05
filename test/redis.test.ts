import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { parseRedisUrl, parseReply, Redis, RedisError, type RedisReply, redisScript } from "../server/redis.ts";

// server/redis.ts, the gateway's Redis client, against a stand-in server that speaks just enough RESP: it
// reads commands with the client's own parser (a command is an array of bulk strings) and answers as each
// test says.

const FIXTURES = join(import.meta.dirname, "fixtures");

const closing: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

type Answer = (command: string[], socket: Socket) => string | undefined;

/** A RESP server answering each command with `answer`'s raw reply (none when it returns undefined). */
async function fakeRedis(answer: Answer): Promise<{ url: string; port: number; seen: string[][]; connections: number; server: Server }> {
  const seen: string[][] = [];
  const sockets = new Set<Socket>();
  const fake = { url: "", port: 0, seen, connections: 0, server: createServer() };
  fake.server.on("connection", (socket) => {
    fake.connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let parsed = parseReply(buffer); parsed; parsed = parseReply(buffer)) {
        buffer = buffer.subarray(parsed[1]);
        const command = parsed[0] as string[];
        seen.push(command);
        const reply = answer(command, socket);
        if (reply !== undefined && !socket.destroyed) socket.write(reply);
      }
    });
  });
  await new Promise<void>((done) => fake.server.listen(0, "127.0.0.1", done));
  fake.port = (fake.server.address() as { port: number }).port;
  fake.url = `redis://127.0.0.1:${fake.port}`;
  closing.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done) => fake.server.close(done));
  });
  return fake;
}

function client(url: string, timeoutMs?: number, onMessage?: (channel: string, message: string) => void): Redis {
  const redis = new Redis(url, { timeoutMs, onMessage });
  closing.push(() => redis.close());
  return redis;
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (const start = Date.now(); !(await condition()); await new Promise((done) => setTimeout(done, 10))) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
  }
}

describe("the Redis client", () => {
  it("reads every kind of reply, however it is cut up", async () => {
    const all = "*8\r\n+OK\r\n:42\r\n$7\r\nhé\r\nlo\r\n$0\r\n\r\n$-1\r\n*-1\r\n*2\r\n:-1\r\n-ERR nested\r\n*0\r\n";
    const fake = await fakeRedis((command, socket) => {
      if (command[0] === "ALL") {
        // A byte at a time, so every reply is read from pieces.
        const bytes = Buffer.from(all);
        bytes.forEach((byte, i) => setTimeout(() => socket.write(Buffer.from([byte])), i));
        return undefined;
      }
      if (command[0] === "BAD") return "-WRONGTYPE Operation against a key holding the wrong kind of value\r\n";
      return "+PONG\r\n";
    });
    const redis = client(fake.url);
    const reply = (await redis.command(["ALL"])) as RedisReply[];
    assert.deepEqual(reply.slice(0, 6), ["OK", 42, "hé\r\nlo", "", null, null]);
    const [number, nested] = reply[6] as RedisReply[];
    assert.equal(number, -1);
    assert.ok(nested instanceof RedisError && nested.message === "ERR nested");
    assert.deepEqual(reply[7], []);
    // An error reply rejects its own command and no other.
    await assert.rejects(redis.command(["BAD"]), (err: Error) => err instanceof RedisError && /^WRONGTYPE/.test(err.message));
    assert.equal(await redis.command(["PING"]), "PONG");
    assert.deepEqual(fake.seen.at(-1), ["PING"]);
  });

  it("sends commands without waiting for replies, and matches the replies in order", async () => {
    const held: [string, Socket][] = [];
    const fake = await fakeRedis((command, socket) => {
      held.push([command[1], socket]);
      // Nothing is answered until all three have arrived: the client didn't wait for the first reply.
      if (held.length === 3) for (const [arg, s] of held) s.write(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
      return undefined;
    });
    const redis = client(fake.url);
    const replies = await Promise.all([redis.command(["ECHO", "one"]), redis.command(["ECHO", "two"]), redis.command(["ECHO", "three"])]);
    assert.deepEqual(replies, ["one", "two", "three"]);
    assert.equal(fake.connections, 1);
  });

  it("logs in and picks the database first, and says when the password is refused", async () => {
    const fake = await fakeRedis((command) => {
      if (command[0] === "AUTH") return command.at(-1) === "right" ? "+OK\r\n" : "-WRONGPASS invalid username-password pair or user is disabled.\r\n";
      return "+OK\r\n";
    });
    assert.equal(await client(`redis://worker:right@127.0.0.1:${fake.port}/3`).command(["PING"]), "OK");
    assert.deepEqual(fake.seen.splice(0), [["AUTH", "worker", "right"], ["SELECT", "3"], ["PING"]]);
    await assert.rejects(client(`redis://:wrong@127.0.0.1:${fake.port}`).command(["PING"]), /Redis refused AUTH: WRONGPASS/);
    assert.deepEqual(fake.seen[0], ["AUTH", "wrong"]);
  });

  it("fails what was in flight when the connection drops, then connects again", async () => {
    let drop = true;
    const fake = await fakeRedis((command, socket) => {
      if (drop && command[0] === "GET") {
        drop = false;
        socket.destroy();
        return undefined;
      }
      return "+back\r\n";
    });
    const redis = client(fake.url);
    await assert.rejects(redis.command(["GET", "k"]), /connection to Redis closed/);
    // For the backoff time commands fail at once; then one connects again.
    await until(async () => (await redis.command(["GET", "k"]).catch(() => "")) === "back", "the client to connect again");
    assert.equal(fake.connections, 2);
  });

  it("gives up on a command Redis doesn't answer, and on a server that isn't there", async () => {
    const fake = await fakeRedis(() => undefined);
    const start = Date.now();
    await assert.rejects(client(fake.url, 200).command(["PING"]), /did not answer within 200 ms/);
    assert.ok(Date.now() - start < 2000);
    const dead = createServer();
    await new Promise<void>((done) => dead.listen(0, "127.0.0.1", done));
    const { port } = dead.address() as { port: number };
    await new Promise((done) => dead.close(done));
    await assert.rejects(client(`redis://127.0.0.1:${port}`).command(["PING"]), /ECONNREFUSED/);
  });

  it("runs a script by its hash, sending it whole only when Redis lacks it", async () => {
    const script = redisScript("return ARGV[1]");
    let loaded = false;
    const fake = await fakeRedis((command) => {
      if (command[0] === "EVALSHA") return loaded ? `$1\r\n${command[4]}\r\n` : "-NOSCRIPT No matching script. Please use EVAL.\r\n";
      loaded = true;
      return `$1\r\n${command[4]}\r\n`;
    });
    const redis = client(fake.url);
    assert.equal(await redis.eval(script, ["k"], ["a"]), "a");
    assert.equal(await redis.eval(script, ["k"], ["b"]), "b");
    assert.deepEqual(fake.seen.map((command) => command[0]), ["EVALSHA", "EVAL", "EVALSHA"]);
    assert.deepEqual(fake.seen[0], ["EVALSHA", script.sha, "1", "k", "a"]);
    assert.equal(fake.seen[1][1], "return ARGV[1]");
  });

  it("hears a channel's messages, and subscribes again after a reconnection", async () => {
    let sockets: Socket[] = [];
    const fake = await fakeRedis((command, socket) => {
      sockets.push(socket);
      return `*3\r\n$9\r\nsubscribe\r\n$${command[1].length}\r\n${command[1]}\r\n:1\r\n`;
    });
    const heard: string[] = [];
    const redis = client(fake.url, undefined, (channel, message) => heard.push(`${channel}: ${message}`));
    await redis.subscribe("released");
    await until(() => sockets.length === 1, "the subscription");
    sockets[0].write("*3\r\n$7\r\nmessage\r\n$8\r\nreleased\r\n$4\r\nacme\r\n");
    await until(() => heard.length === 1, "the message");
    sockets[0].destroy();
    sockets = [];
    await until(() => sockets.length === 1, "the subscription again");
    assert.deepEqual(fake.seen.map((command) => command.join(" ")), ["SUBSCRIBE released", "SUBSCRIBE released"]);
    sockets[0].write("*3\r\n$7\r\nmessage\r\n$8\r\nreleased\r\n$5\r\nother\r\n");
    await until(() => heard.length === 2, "the second message");
    assert.deepEqual(heard, ["released: acme", "released: other"]);
  });

  it("connects over TLS for rediss://, giving the server name only when it is a name", async () => {
    // A server with a certificate for 127.0.0.1, which answers PONG to every command.
    const cert = await readFile(join(FIXTURES, "k8s-api.crt"), "utf8");
    const sockets = new Set<TLSSocket>();
    const server = createTlsServer({ key: await readFile(join(FIXTURES, "k8s-api.key")), cert }, (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      let buffer: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (let parsed = parseReply(buffer); parsed; parsed = parseReply(buffer)) {
          buffer = buffer.subarray(parsed[1]);
          socket.write("+PONG\r\n");
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    closing.push(() => (sockets.forEach((socket) => socket.destroy()), new Promise((done) => server.close(done))));
    // An IP address as the TLS server name is against RFC 6066, and Node warns of it (DEP0123).
    const warnings: (Error & { code?: string })[] = [];
    const warned = (warning: Error) => warnings.push(warning);
    process.on("warning", warned);
    closing.push(() => process.off("warning", warned));
    const redis = new Redis(`rediss://127.0.0.1:${(server.address() as AddressInfo).port}`, { ca: cert });
    closing.push(() => redis.close());
    assert.equal(await redis.command(["PING"]), "PONG");
    await new Promise((done) => setImmediate(done)); // a warning is emitted on the next tick
    assert.deepEqual(warnings.filter((warning) => warning.code === "DEP0123"), []);
  });

  it("reads Redis URLs", () => {
    assert.deepEqual(parseRedisUrl("redis://:p%40ss@cache:6380/1"), { host: "cache", port: 6380, tls: false, username: undefined, password: "p@ss", db: 1 });
    assert.deepEqual(parseRedisUrl("rediss://user:pw@[::1]"), { host: "::1", port: 6379, tls: true, username: "user", password: "pw", db: 0 });
    assert.throws(() => parseRedisUrl("http://cache"), /Not a redis/);
    assert.throws(() => parseRedisUrl("redis://cache/x"), /database/);
  });
});
