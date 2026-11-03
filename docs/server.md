# jig as a service

jig runs one task in a terminal; `server/` runs many, for many tenants, behind an HTTP API. It has three
parts: the control plane (the task service: the API, the store, the scheduler), the execution plane (the
runners, which start jig headless for each task in a workspace of its own) and the model gateway, which
holds the real provider keys, so a task's jig gets only a token. The work goes in three phases: in Phase 1,
the event protocol, the gateway, the task service with its queue and fair scheduler, and Docker and
Kubernetes runners; in Phase 2, jig as a library, approvals over the API, state off the machine and warm
pools; in Phase 3, several regions, provider failover, quotas and billing, and observability.

The server code is TypeScript that Node runs directly, as `src/` is, with no dependencies beyond Node's own
modules, and it isn't part of the npm package.

## The task service

`server/api.ts` is the API, `server/store.ts` the state (tenants, tasks and their events, in SQLite through
`node:sqlite`, in WAL mode, the schema moved on by `PRAGMA user_version`), `server/scheduler.ts` starts
queued tasks, and `server/runner.ts` is what a runner keeps to: `start(task, tenant)` gives a handle with
the run's events, `wait()` and `cancel()`. The local runner, `server/runners/local.ts`, runs jig as a
process on the same machine.

Run it with a config file and the secret it shares with the gateway:

```bash
JIG_GATEWAY_SECRET=$(cat gateway-secret) node server/api.ts --config service.json
```

```json
{
  "port": 8080,
  "database": "data/jig.db",
  "dataDir": "data",
  "concurrency": 8,
  "model": "deepseek-flash",
  "gatewayBaseUrl": "http://127.0.0.1:8081/anthropic",
  "tenants": [
    { "id": "acme", "keys": ["<sha256 of acme's API key, in hex>"], "concurrency": 2, "maxSteps": 50, "timeLimit": 1800, "budgetUsd": 5 }
  ]
}
```

Paths are relative to the config file. `host` defaults to 127.0.0.1, `concurrency` (tasks at once, across
tenants) to 4; a tenant's `concurrency` to 2, `maxSteps` to 50, `timeLimit` to 1800 seconds and `budgetUsd`
(the most one task may spend, which the gateway holds it to) to none. The config holds only the SHA-256 of
each key: `printf %s "$KEY" | sha256sum` gives it. Also: `graceSeconds` (30), `jig` (the program and first
arguments that start jig: this checkout's `src/cli.ts` by default), `gitProtocols` (`["https"]`),
`maxBodyBytes` (1 MiB) and `heartbeatSeconds` (15).

### The API

Every request but `GET /healthz` takes a tenant's key, `Authorization: Bearer <key>` (401 without one). A
tenant sees only its own tasks: another's is a 404, as one that doesn't exist is.

```bash
# A task: the prompt, and maybe its files or a repository to clone; maxSteps, timeLimit (seconds) and model
# default to the tenant's limits and the service's model, and can't go past the limits. -> 201 {"id", "status"}
curl -s localhost:8080/v1/tasks -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prompt": "the test in test_app.py fails, fix it", "workspace": {"files": {"app.py": "...", "test_app.py": "..."}}}'
curl -s localhost:8080/v1/tasks -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prompt": "...", "workspace": {"git": "https://github.com/owner/repo", "ref": "main"}, "maxSteps": 30}'

curl -s localhost:8080/v1/tasks/$ID -H "Authorization: Bearer $KEY"             # the task, with its usage, cost and stats
curl -s 'localhost:8080/v1/tasks?status=running' -H "Authorization: Bearer $KEY" # the tenant's latest 100, newest first
curl -s -X POST localhost:8080/v1/tasks/$ID/cancel -H "Authorization: Bearer $KEY"

# Its events (jig's --events lines) as server-sent events, each one's id its seq: those so far, the rest
# as they come, then "event: done" with the status, and the stream ends. Last-Event-ID (or ?after=)
# resumes after that seq.
curl -sN localhost:8080/v1/tasks/$ID/events -H "Authorization: Bearer $KEY"
curl -sN localhost:8080/v1/tasks/$ID/events -H "Authorization: Bearer $KEY" -H 'Last-Event-ID: 12'
```

A request is refused with 400 and the reason when a field is unknown or out of bounds, the model isn't a
Claude or DeepSeek one (the gateway serves the Anthropic API), a workspace file's path is absolute, goes
through `..` or names a folder, or the workspace has both files and a repository; with 413 when the body is
over `maxBodyBytes`. A cancel answers 200 for a queued task (it is cancelled at once), 202 for a running
one (its jig and everything it started are killed, and the task ends `cancelled`) and 409 for one that has
ended. A stream sends a comment every `heartbeatSeconds`, so proxies don't close it.

A task is `queued`, then `running`, then one of:

| status | when |
|--------|------|
| `succeeded` | jig exited with 0: the model finished |
| `stopped` | the run stopped short at a limit: steps (exit 2), the output limit or context window (3), repeating itself (6), the time limit (7, or the runner's stop past it), empty replies (8), an interruption (130) |
| `failed` | the model declined (4), or tool calls needed approval (5) |
| `cancelled` | cancelled through the API |
| `error` | anything else: jig's own failure (1, with the last line it printed), a workspace that couldn't be made, or the service stopping while it ran |

`stop` is how jig's run ended, from its `end` event (or its exit code, without one), and `usage` and `cost`
come from that event too.

### Scheduling

The scheduler starts queued tasks while fewer than `concurrency` run in all and fewer than the tenant's own
`concurrency` of its, taking the tenants with work queued in turn, from the one after the last to get a
slot: a tenant that queues a thousand tasks takes one slot at a time like the others, and doesn't hold back
another's one. A task is claimed in the store (`queued` to `running`) before it starts, so it never runs
twice. When the service starts, tasks the last run of it left `running` (it crashed, or was killed) are
marked `error`, not run again, since their workspace is half changed; what was still queued runs. A
SIGTERM or Ctrl+C kills the runs and marks them `error` the same way. A local run a crashed service started
can outlive it, until jig's own `--time-limit` stops it.

### The local runner

Each task gets a folder in `dataDir/tasks/<id>/`: `work/`, the project jig works in (the files written
there, or the repository cloned with `--depth 1`, no hooks and only `gitProtocols`), `home/`, its `HOME`
and `JIG_HOME`, and beside them, outside the project where its commands can't write, the events and stats
files and `output.log`, what jig printed. jig runs as

```
jig --yes --model <model> --base-url <gatewayBaseUrl> --max-steps <n> --time-limit <s>
    --events <dir>/events.jsonl --stats <dir>/stats.json -C <dir>/work -
```

with the prompt on stdin, in a process group of its own, so a cancel, or the time limit plus `graceSeconds`
when jig hasn't stopped itself, reaches everything it started: SIGTERM, then SIGKILL after 5 seconds. Its
environment is the service's `PATH`, `LANG`, `LC_ALL`, `TZ` and `TMPDIR`, and as its API key
(`ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY` for a DeepSeek model) the task's gateway token:
`jgt1.` + base64url(`{"tenant", "task", "exp", "budgetUsd"}`) + `.` + base64url(HMAC-SHA256 of what comes
before the dot, keyed by `JIG_GATEWAY_SECRET`), good until the time limit, the grace and a minute more. No
provider key, and nothing else of the service's, reaches it. The runner reads the events file as jig
writes it, into the store and to the streams.
