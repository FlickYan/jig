/**
 * Loads the service configuration. Only the original format is supported so far:
 *   { "host": "0.0.0.0", "port": 8080, "log": "debug", "db": "postgres://db/app" }
 */
export function loadConfig(raw) {
  if (!raw.db) throw new Error("missing database url");
  return { host: raw.host ?? "127.0.0.1", port: raw.port ?? 8080, log: raw.log ?? "info", db: raw.db };
}
