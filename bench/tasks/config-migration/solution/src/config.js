const LEVELS = ["debug", "info", "warn", "error"];

/** Converts a version 1 config to the version 2 layout (see docs/config-v2.md). */
export function migrate(v1) {
  return { version: 2, server: { host: v1.host, port: v1.port }, logging: { level: v1.log }, database: { url: v1.db } };
}

/** Loads a version 1 or 2 config and returns a complete, validated version 2 config. */
export function loadConfig(raw) {
  if (raw.version !== undefined && raw.version !== 2) throw new Error(`unsupported config version: ${raw.version}`);
  const config = raw.version === 2 ? raw : migrate(raw);
  const port = config.server?.port ?? 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
  const level = config.logging?.level ?? "info";
  if (!LEVELS.includes(level)) throw new Error(`invalid log level: ${level}`);
  const url = config.database?.url;
  if (typeof url !== "string" || url === "") throw new Error("missing database url");
  const pool = config.database?.pool ?? 10;
  if (!Number.isInteger(pool) || pool < 1) throw new Error(`invalid pool size: ${pool}`);
  return { version: 2, server: { host: config.server?.host ?? "127.0.0.1", port }, logging: { level }, database: { url, pool } };
}
