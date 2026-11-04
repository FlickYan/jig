import { createHmac, timingSafeEqual } from "node:crypto";

// A task's credential for the model gateway. The task service mints one for each run and gives it to jig
// as its API key; the gateway verifies it and calls the provider with a real key, so a sandbox never holds
// one. Both read the shared secret from JIG_GATEWAY_SECRET. The format is the contract in docs/server.md:
// "jgt1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, "jgt1." + base64url(payload))).

const PREFIX = "jgt1.";

export interface TokenPayload {
  tenant: string;
  task: string;
  /** When it stops working, in Unix seconds. */
  exp: number;
  /** What the task may spend through the gateway, in USD; null for no limit. */
  budgetUsd: number | null;
}

function sign(secret: string, signed: string): Buffer {
  return createHmac("sha256", secret).update(signed).digest();
}

/** A token for `payload`, signed with `secret`. */
export function mintToken(secret: string, payload: TokenPayload): string {
  const signed = PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${signed}.${sign(secret, signed).toString("base64url")}`;
}

/**
 * The payload of a token signed with `secret` that hasn't expired, or an Error saying what is wrong with it.
 * The signature is compared in constant time, and checked before anything in the payload is read.
 */
export function verifyToken(secret: string, token: string, now = Date.now() / 1000): TokenPayload | Error {
  if (!secret) return new Error("the gateway has no secret");
  const dot = token.lastIndexOf(".");
  if (!token.startsWith(PREFIX) || dot <= PREFIX.length) return new Error("not a gateway token");
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = sign(secret, token.slice(0, dot));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Error("the token's signature does not match");
  let payload: Partial<TokenPayload>;
  try {
    payload = JSON.parse(Buffer.from(token.slice(PREFIX.length, dot), "base64url").toString("utf8"));
  } catch {
    return new Error("the token's payload is not JSON");
  }
  const { tenant, task, exp, budgetUsd } = payload ?? {};
  if (typeof tenant !== "string" || !tenant || typeof task !== "string" || !task || typeof exp !== "number" || !(budgetUsd === null || typeof budgetUsd === "number")) {
    return new Error("the token's payload is not {tenant, task, exp, budgetUsd}");
  }
  if (exp <= now) return new Error("the token has expired");
  return { tenant, task, exp, budgetUsd };
}
