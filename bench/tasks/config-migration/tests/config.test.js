import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, migrate } from "../src/config.js";

const deepFreeze = (value) => {
  if (value && typeof value === "object") Object.values(Object.freeze(value)).forEach(deepFreeze);
  return value;
};

test("migrates a version 1 config", () => {
  const v1 = deepFreeze({ host: "0.0.0.0", port: 9000, log: "debug", db: "postgres://db/app" });
  assert.deepEqual(migrate(v1), {
    version: 2,
    server: { host: "0.0.0.0", port: 9000 },
    logging: { level: "debug" },
    database: { url: "postgres://db/app" },
  });
  assert.deepEqual(loadConfig(v1), {
    version: 2,
    server: { host: "0.0.0.0", port: 9000 },
    logging: { level: "debug" },
    database: { url: "postgres://db/app", pool: 10 },
  });
});

test("fills in defaults for both versions", () => {
  const expected = {
    version: 2,
    server: { host: "127.0.0.1", port: 8080 },
    logging: { level: "info" },
    database: { url: "postgres://x", pool: 10 },
  };
  assert.deepEqual(loadConfig(deepFreeze({ db: "postgres://x" })), expected);
  assert.deepEqual(loadConfig(deepFreeze({ version: 2, database: { url: "postgres://x" } })), expected);
});

test("keeps version 2 values and drops unknown keys", () => {
  const raw = deepFreeze({
    version: 2,
    server: { host: "h", port: 1, tls: true },
    logging: { level: "error" },
    database: { url: "u", pool: 3 },
    extra: 1,
  });
  assert.deepEqual(loadConfig(raw), { version: 2, server: { host: "h", port: 1 }, logging: { level: "error" }, database: { url: "u", pool: 3 } });
});

test("rejects invalid settings with the documented messages", () => {
  const cases = [
    [{ db: "u", port: 0 }, "invalid port: 0"],
    [{ db: "u", port: 70000 }, "invalid port: 70000"],
    [{ db: "u", port: "80" }, "invalid port: 80"],
    [{ db: "u", port: 80.5 }, "invalid port: 80.5"],
    [{ db: "u", log: "verbose" }, "invalid log level: verbose"],
    [{ port: 80 }, "missing database url"],
    [{ version: 2, database: { url: "" } }, "missing database url"],
    [{ version: 2, database: { url: "u", pool: 0 } }, "invalid pool size: 0"],
    [{ version: 3, database: { url: "u" } }, "unsupported config version: 3"],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => loadConfig(deepFreeze(raw)), { message }, JSON.stringify(raw));
  }
});
