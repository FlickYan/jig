# Config format, version 2

Version 2 groups the settings and adds a database connection pool size:

```json
{
  "version": 2,
  "server": { "host": "0.0.0.0", "port": 8080 },
  "logging": { "level": "info" },
  "database": { "url": "postgres://db/app", "pool": 10 }
}
```

Configs without a `version` field are version 1 (the original flat format:
`{ "host", "port", "log", "db" }`).

## Loading

`loadConfig(raw)` in `src/config.js` accepts both versions and always returns a complete version 2 object:

- `raw.version === 2`: validate it and fill in the defaults.
- no `version` field: convert it with `migrate(raw)`, then validate and fill in the defaults.
- any other version: throw `Error("unsupported config version: <version>")`.

## Migrating from version 1

`migrate(v1)`, also exported from `src/config.js`, maps `host` to `server.host`, `port` to `server.port`,
`log` to `logging.level` and `db` to `database.url`, and sets `version: 2`.

## Defaults and validation

| Setting         | Default       | Must be                               | Error message                 |
| --------------- | ------------- | ------------------------------------- | ----------------------------- |
| `server.host`   | `"127.0.0.1"` |                                       |                               |
| `server.port`   | `8080`        | an integer from 1 to 65535            | `invalid port: <value>`       |
| `logging.level` | `"info"`      | one of `debug`, `info`, `warn`, `error` | `invalid log level: <value>` |
| `database.url`  | (required)    | a non-empty string                    | `missing database url`        |
| `database.pool` | `10`          | an integer, at least 1                | `invalid pool size: <value>`  |

Errors are plain `Error`s with exactly these messages. Unknown keys are dropped. Neither function may
modify the object it is given.
