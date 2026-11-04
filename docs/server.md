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

`server/api.ts` is the API, `server/store.ts` the state (tenants, tasks and their events: in SQLite through
`node:sqlite`, in WAL mode, the schema moved on by `PRAGMA user_version`, or in Postgres, below),
`server/scheduler.ts` starts
queued tasks, and `server/runner.ts` is what a runner keeps to: `start(task, tenant)` gives a handle with
the run's events, `wait()` and `cancel()`. The local runner, `server/runners/local.ts`, runs jig as a
process on the same machine; the Docker and Kubernetes runners (below) run each task in a container of its
own, which is what keeps tenants apart: jig's sandbox protects a user's machine from the model, but its
commands share the machine's kernel, so it is no wall between tenants.

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

Paths are relative to the config file, and the database's folder is made if it isn't there. `host` defaults
to 127.0.0.1, `concurrency` (tasks at once, across tenants) to 4; a tenant's `concurrency` to 2, `maxSteps`
to 50, `timeLimit` to 1800 seconds, `budgetUsd` (the most one task may spend, which the gateway holds it to)
to none and `maxQueued` (its tasks that may wait at once) to 1000. The config holds only the SHA-256 of each
key: `printf %s "$KEY" | sha256sum` gives it. A tenant taken out of the config is shut out at the next
start: its keys stop working, and its queued tasks are cancelled. Also: `graceSeconds` (30), `jig` (the
program and first arguments that start jig: this checkout's `src/cli.ts` by default), `gitProtocols`
(`["https"]`), `maxBodyBytes` (1 MiB) and `heartbeatSeconds` (15), and `runner`: `local` (the default),
`docker` or `kubernetes`, with its settings in a `docker` or `kubernetes` block. `maxEvents` (10,000) is
the most of a task's events that are stored: past it they are dropped, but for the `end`, with one `notice`
event in place of the first dropped, and the run goes on, so a task's commands can't fill the database.
`keepTaskDirs` (false) keeps each task's folder after it ends, which is otherwise removed. A config the
service can't run with (`concurrency` 0, a key's hash given to two tenants, a field of the wrong type) is
refused at the start, with the field and what is wrong with it.

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
# The tenant's latest 100 (or ?limit=), newest first, without their prompts unless ?full=1; with "next"
# when the page is full, the id that ?before= takes for the page after it.
curl -s 'localhost:8080/v1/tasks?status=running' -H "Authorization: Bearer $KEY"
curl -s "localhost:8080/v1/tasks?limit=20&before=$NEXT" -H "Authorization: Bearer $KEY"
curl -s -X POST localhost:8080/v1/tasks/$ID/cancel -H "Authorization: Bearer $KEY"

# Its events (jig's --events lines) as server-sent events, each one's id its seq: those so far, the rest
# as they come, then "event: done" with the status, and the stream ends. Last-Event-ID (or ?after=)
# resumes after that seq.
curl -sN localhost:8080/v1/tasks/$ID/events -H "Authorization: Bearer $KEY"
curl -sN localhost:8080/v1/tasks/$ID/events -H "Authorization: Bearer $KEY" -H 'Last-Event-ID: 12'
```

A request is refused with 400 and the reason when a field is unknown or out of bounds, the model isn't a
Claude or DeepSeek one (the gateway serves the Anthropic API), a workspace file's path is absolute, goes
through `..` or names a folder, the workspace has both files and a repository, or the prompt holds a NUL
character (`\u0000`, which Postgres text can't hold, so no store takes it); with 413 when the body is
over `maxBodyBytes`; with 429 when the tenant already has `maxQueued` tasks queued, or is at one of its
quotas (below). A cancel answers 200 for
a queued task (it is cancelled at once), 202 for a running one (its jig and everything it started are
killed, and the task ends `cancelled`) and 409 for one that has ended. A stream sends a comment every
`heartbeatSeconds`, so proxies don't close it.

A task is `queued`, then `running`, then one of:

| status | when |
|--------|------|
| `succeeded` | jig exited with 0: the model finished |
| `stopped` | the run stopped short at a limit: steps (exit 2), the output limit or context window (3), repeating itself (6), the time limit (7, or the runner's stop past it), empty replies (8), an interruption (130) |
| `failed` | the model declined (4), or tool calls needed approval (5) |
| `cancelled` | cancelled through the API |
| `error` | anything else: jig's own failure (1, with the last line it printed), a workspace that couldn't be made, or the service stopping while it ran |

`stop` is how jig's run ended, from its `end` event (or its exit code, without one), and `usage` and `cost`
come from that event too. A NUL character in `stop` or `error`, which come from what the run wrote, is
stored as U+FFFD.

### Scheduling

The scheduler starts queued tasks while fewer than `concurrency` run in all and fewer than the tenant's own
`concurrency` of its, taking the tenants with work queued in turn, from the one after the last to get a
slot: a tenant that queues a thousand tasks takes one slot at a time like the others, and doesn't hold back
another's one. It reads only the next task of the tenant whose turn it is, never the whole queue, so a long
queue doesn't slow the service. A task is claimed in the store (`queued` to `running`) before it starts, so
it never runs twice, and the running tasks are counted there, so replicas sharing the store keep to the
caps together (below).

A running task is leased to the service (the replica) that runs it, for `leaseSeconds` (30), and the
lease is renewed every third of that while the run goes on. A task whose lease ran out has lost its
replica (it crashed, was killed, or lost the database) and is marked `error` by whichever replica sees it
first, at its start or as it renews its own; it isn't run again, since its workspace is half changed, and
what was still queued runs. So a crashed service's tasks end up to `leaseSeconds` after it is gone, and a
service that restarts finds them so. A replica that finds it no longer holds a task it runs (its lease ran
out while the database was away) stops the run. A SIGTERM or Ctrl+C kills the runs and marks them `error`.
A local run a crashed service started can outlive it, until jig's own `--time-limit` stops it.

### Several replicas, on Postgres

With `"database": "postgres://user:password@host:5432/jig?sslmode=require"` (or the URL in
`JIG_DATABASE_URL`, which takes the config's place, as a password belongs in a secret), the state is in
Postgres, through `server/pg.ts`, a client of jig's own with no dependencies (SCRAM-SHA-256, md5 or
cleartext logins; `sslmode=require` checks the server's certificate against the system's CAs, or the file
in `sslrootcert`), and several replicas of the service share it: each runs the same config, with a
`replicaId` of its own (the host's name, the process's id and a random part, by default). The schema is
moved on by the `jig_schema` table, under a lock, so replicas starting together do it once.

A task posted to any replica is in the one queue, and whichever replica has a slot first runs it. A claim
counts the running tasks in the database under a lock it holds to its transaction's end, so `concurrency`
and each tenant's own hold across the replicas, and two can't both take the last slot; the turn among
tenants is each replica's own. A run's events are stored and announced (`NOTIFY jig_events`), so a stream
through any replica gets them as they come; a cancel through a replica that doesn't run the task marks it
and announces it (`jig_cancel`), and the one that runs it stops it, or finds the mark when it renews its
leases. While a replica's connection that hears these is lost, its streams read the database every second,
and it connects again. A replica that crashes leaves its runs going (a Kubernetes Job until its deadline);
its tasks end as `error` once their leases run out, and the others go on. SQLite takes several processes
on one machine too, with no announcements: streams read it every second, and a cancel is found as leases
are renewed.

### Approvals

A task posted with `"approvals": true` asks before the tool calls its `mode` doesn't allow (`plan`, `ask`
or `edits`, the default: jig's `--mode` values but `auto`), and a person answers through the API while it
waits; one without runs with `--yes`, as before. Its jig gets `--mode <mode> --approve-via
<internalBaseUrl>/internal/approvals --approval-timeout <the tenant's approvalTimeout>` in `--yes`'s place,
and where it would ask at a terminal it writes an `approval_request` event and waits for the answer. The
approval exists once that event is stored.

```bash
curl -s localhost:8080/v1/tasks -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prompt": "...", "approvals": true, "mode": "ask"}'
# {"approvals": [{"id": "ap_1", "step", "tool", "description", "requestedAt", and once answered "decision", "always", "by", "decidedAt"}]}
curl -s localhost:8080/v1/tasks/$ID/approvals -H "Authorization: Bearer $KEY"
curl -s localhost:8080/v1/tasks/$ID/approvals/ap_1 -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"decision": "allow", "always": true}'
```

An answer is 200 with the approval, 404 for one the task hasn't asked for (or not yet), and 409 for one
answered already or a task that has ended. `allow` runs the call, and with `always` is the terminal's
"always" answer; `deny` is the terminal's no, and the model reads that the user declined. A task's view
has `approvals`, its `mode` and `pendingApprovals`, how many wait for an answer (0 once it has ended).
With no answer within the tenant's `approvalTimeout` (600 seconds), jig takes a deny; the task's time limit
runs on while it waits. jig's own `approval` event says how each was answered in the end (`by`: `api`, or
`timeout`), and that is the record the list shows. An approval asked for past `maxEvents` isn't stored, so
it times out as a deny. The answer jig is given is always the API's, though: on Docker and Kubernetes a
task's commands can write its events, so the record of how jig acted is only as good as they are. An
`approval` event that says the API answered when it didn't, or answered otherwise, is left out of the
record (and logged), and a timeout is only ever a deny.

jig waits on a second listener, `internal` (`{"host", "port"}`, 127.0.0.1:8082 by default), which serves
only `GET /internal/approvals/<id>?wait=<seconds>` and `GET /healthz`. Its Bearer is the task's gateway
token, checked as the gateway checks it, so a task gets only its own approvals' answers; the request is
held until the answer comes, for 30 seconds at most, then gets 200 `{"decision", "always"}`, or 204 while
there is none. `internalBaseUrl` is where the tasks reach it (`http://<internal host>:<port>` by default):
`http://api:8082` on the Docker network, the `jig-api-internal` Service on Kubernetes. Any replica can
hold the request: an answer given through another is announced on Postgres (`NOTIFY jig_approvals`), and
found within a second on SQLite. Replicas on one machine each need a port of their own for it, as for the
API.

A tenant with `approvalWebhook` (a URL) and `webhookSecretEnv` (the variable that holds its secret, which
must be set) is told of each approval as it is stored: a POST of `{"task": <id>, "approval": {...}}`,
signed in `x-jig-signature: sha256=<hex HMAC-SHA256 of the body, keyed by the secret>`. One that fails (not
2xx, or no answer in 10 seconds) is tried again 3 times, 1, 2 and 4 seconds apart; the run never waits on
it.

### Quotas and usage

A tenant's `quotas` cap what it may start in a UTC day, and what its tasks may spend in a UTC day or month:

```json
{ "id": "acme", "keys": ["..."], "quotas": { "tasksPerDay": 500, "usdPerDay": 50, "usdPerMonth": 1000 } }
```

Each is no limit when left out. `tasksPerDay` counts the tasks the tenant created that day, whatever became
of them; `usdPerDay` and `usdPerMonth` add up the cost of its tasks that ended that day or month, from the
usage ledger (below). A task posted at one of them is refused with 429, `{"error", "quota", "limit",
"used", "resetsAt"}`, `resetsAt` being the start of the next UTC day (of the next month, for
`usdPerMonth`), and `retry-after` the seconds until then. They are counted with the task's insert, under a
lock of the tenant's (Postgres's, or SQLite's write lock), so replicas can't both let in a tenant's last
task of the day; `maxQueued` is counted the same way. The USD quotas count only tasks that have ended, so
the tasks running when one is reached can take the tenant past it by what they spend: the service only
refuses new tasks, and spending is held as it happens by the gateway, which sees every model call (each
task's `budgetUsd`, and its own limits, below).

Each task that ends, however it ends (a cancel before it started, or a replica lost, too), writes a row of
the ledger, the `usage` table, in the transaction that ends it, once: `tenant`, `task`, `day` (the UTC day it
ended, `YYYY-MM-DD`), `model`, `status`, `input`, `output`, `cache_read`, `cache_write`, `cost_usd` and
`seconds` (from its start to its end; 0 if it never started). The tokens and cost are those of jig's `end`
event, as the task's view has them: a run with none (killed, or lost with its replica) counts 0, and on
Docker and Kubernetes a task's commands can write that event, so for what a tenant must pay the gateway's
counts are the record. Tasks that ended before the ledger came have no row.

```bash
# The tenant's own usage, by UTC day, model or both (day,model), over from..to (both included; this month
# to today by default, 366 days at most):
# {"from", "to", "rows": [{"day", "model", "tasks", "input", "output", "cacheRead", "cacheWrite", "costUsd", "seconds"}], "total": {...}}
curl -s 'localhost:8080/v1/usage?from=2026-11-01&to=2026-11-30&group=day,model' -H "Authorization: Bearer $KEY"
# The same rows as CSV, with a header line.
curl -s 'localhost:8080/v1/usage?group=model&format=csv' -H "Authorization: Bearer $KEY"
# Every tenant's, each row with its tenant, or one tenant's, to the admin key.
curl -s 'localhost:8080/admin/usage?from=2026-10-01&to=2026-10-31&group=model&format=csv' -H "Authorization: Bearer $JIG_ADMIN_KEY"
curl -s 'localhost:8080/admin/usage?from=2026-10-01&to=2026-10-31&tenant=acme' -H "Authorization: Bearer $JIG_ADMIN_KEY"
```

Rows are sorted by what they are grouped by, and a day or model with no task is left out; a range or group
that isn't one is a 400. `/admin/usage` is there only with `adminKeyEnv` in the config, the environment
variable that holds the admin key (which must be set); without it every `/admin` route is a 404. To bill a
month, take the admin's CSV of it by model once it is over, or read the `usage` table, by `(tenant, day)`.

### Metrics and logs

With a `metrics` block, `{"host", "port"}` (host 127.0.0.1 by default), each replica serves its metrics in
Prometheus's text format on a listener of its own, which answers only `GET /metrics` and `GET /healthz`:
apart from the tenants' API, and from the internal listener the tasks reach. Without the block there is
none. A label is never a key, a token, a prompt or a task's id: a route is its template (`/v1/tasks/:id`).

| metric | what |
|--------|------|
| `jig_service_http_requests_total{route,status}`, `jig_service_http_request_seconds{route}` | the API's requests, and their seconds to the end of the response (an event stream's lasts as long as it is followed) |
| `jig_service_tasks_created_total{tenant}`, `jig_service_tasks_refused_total{tenant,reason}` | tasks posted, and refused: `queue` (`maxQueued`), `quota`, or `invalid` (a 400 or 413) |
| `jig_service_tasks_ended_total{tenant,status}`, `jig_service_run_seconds{status}` | tasks ended, and their seconds from start to end |
| `jig_service_queue_seconds`, `jig_service_start_seconds{start}` | seconds from a task's creation to its start, and from its start to jig's first event, `warm` or `cold` |
| `jig_service_pool_idle`, `jig_service_pool_takes_total{result}` | warm workers waiting, and the tasks started with a pool: `hit` (a warm worker took it) or `miss` (it started cold) |
| `jig_service_approval_wait_seconds{decision}` | seconds from an approval's request to its answer: `allow`, `deny` or `timeout` (a timeout by jig's events' times) |
| `jig_service_lease_errors_total`, `jig_service_store_errors_total` | rounds of renewing the leases that failed, and reads and writes of the store that failed outside a request |
| `jig_service_cost_usd_total{tenant}`, `jig_service_tokens_total{tenant,kind}` | what the tasks spent, from their end events (`kind`: `input`, `output`, `cache_read`, `cache_write`) |
| `jig_service_tasks{tenant,status}`, `jig_service_queue_oldest_seconds{tenant}` | tasks `queued` and `running`, and how long each tenant's oldest queued task has waited |
| `jig_service_approvals_pending`, `jig_service_replicas` | approvals of running tasks waiting for an answer, and the replicas up |

The counters and histograms are the replica's own, a task counted by the replica that ended it (that
started it, for its queue's seconds), so their sum over the replicas is the service's. The last two rows are
read from the store at a scrape, at most every 5 seconds however many scrape, and are the whole store's: on
Postgres each replica gives the same numbers, so take their max, not their sum. A replica is up while its
heartbeat in the store, written every third of `leaseSeconds`, holds: it is forgotten as it stops, or a
lease's length after it crashed.

Every response, from each listener, carries `x-request-id`: the client's, if it sent one of at most 128
letters, digits, `_`, `.` and `-`, or else one of the service's own. It isn't passed to the runs. The
service's lines on stderr are `jig service: ...` with their fields after them, or with
`JIG_LOG_FORMAT=json` one JSON object a line (`ts`, `level`, `component`, `msg`, then fields such as
`request`, `tenant`, `task` and `err`); `JIG_LOG_LEVEL` (`info` by default) is the least a line must be. At
`debug` there is a line for each request (its `request`, method, path, status, `ms` and `tenant`) and for
each task started and ended; at `error`, a request that failed (a 500) and the store's failures, with the
error as `err`. The Kubernetes runner's few lines (a Job it couldn't delete) are still plain text.

`deploy/observability/` has what watches a fleet: `prometheus.yml` scrapes the service's, the gateway's
and the router's metrics listeners (the Kubernetes pods that ask to be, or addresses written down);
`alerts.yml` holds Prometheus rules for a queue backing up, tasks or requests failing, failovers, an
upstream's breaker open, a provider's keys used up, quota refusals, a region down, and the store's, the
leases' or Redis's errors; and `grafana-dashboard.json` is a dashboard of all three, by region. In
`deploy/k8s/` the service's metrics listener is on port 9180 and the gateway's on 9181, the pods carry
`prometheus.io/scrape` and `prometheus.io/port`, and NetworkPolicies let only the `monitoring` namespace
reach those ports (the tenants' API from anywhere, the internal listener and the gateway from the pods in
`jig`).

### The local runner

Each task gets a folder in `dataDir/tasks/<id>/`: `work/`, the project jig works in (the files written
there, or the repository cloned with `--depth 1`, no hooks and only `gitProtocols`), `home/`, its `HOME`
and `JIG_HOME`, and beside them, outside the project where its commands can't write, the events and stats
files and `output.log`, what jig printed. The folder is removed once the task has ended and its outcome
is stored (unless `keepTaskDirs`), as the Docker runner's is. jig runs as

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

### The Docker runner

`"runner": "docker"` starts each task with the docker CLI (`docker` on the `PATH`, or the program and first
arguments in `docker.docker`). The task's folder is made as the local runner makes it and bound into the
container at `/task`, and the service reads the events file jig writes there:

```
docker run --rm --interactive --init --name jig-<task id> --label jig.task=<id> --label jig.tenant=<tenant> --user 10001:10001
    --cpus 1 --memory 2g --memory-swap 2g --pids-limit 512 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m
    --mount type=bind,source=<dataDir>/tasks/<id>,target=/task --workdir /task/work
    --cap-drop ALL --security-opt no-new-privileges [--runtime runsc] --network jig-tasks
    --env HOME=/task/home --env JIG_HOME=/task/home/.jig --env NO_COLOR=1 --env ANTHROPIC_API_KEY
    <image> jig --no-sandbox --yes --model <model> ... --events /task/events.jsonl --stats /task/stats.json -C /task/work -
```

```json
"runner": "docker",
"docker": { "image": "jig-worker", "network": "jig-tasks", "runtime": "runsc", "cpus": 1, "memory": "2g", "pidsLimit": 512, "tmpSize": "512m" }
```

`image` (built from `deploy/Dockerfile.worker`) and `network` are needed; `runtime` (`runsc` for gVisor,
`kata` for Kata Containers) is left to the daemon's default without one; the limits default as above. The
token is passed by name, its value in the docker CLI's environment, which holds only `PATH`, `HOME` and
the `DOCKER_*` variables of the service's. jig runs with `--no-sandbox` in the container: bubblewrap would
need Docker's seccomp filter and `/proc` masks loosened, which would weaken the container, the wall that
matters here. So its commands can write anything in `/task`, the events included: the service reads those
files only where they are regular files, not links, a chunk at a time, and leaves out any line over 1 MiB
without holding it, so what a task writes there can make up its own events (what it costs is the
gateway's to count) but not fill the service's memory. A run whose events can't be read or stored is
stopped, and keeps its slot until it has ended. A cancel or the time limit is `docker kill --signal TERM`,
sent again each second until it reaches the container (one whose image is still being pulled doesn't
exist yet), then `docker kill` 5 seconds later, again each second until the run ends; a container a
crashed service left runs until jig's own `--time-limit`.

The network must reach only the gateway and the service's internal listener: an internal network (`docker
network create --internal jig-tasks`) with the gateway and the service attached to it too (`docker network
connect jig-tasks <gateway>`, and the same for the service), so the tasks reach them by their names there (`"gatewayBaseUrl":
"http://gateway:8081/anthropic"`, `"internalBaseUrl": "http://api:8082"`) and nothing else. The tenants' API
is on that network too, but takes only tenants' keys, which no task holds.
The daemon binds the task folders by their path on its own machine, so a service in a container must have
`dataDir` at the same path as on the host. A service running as root gives each task folder to
`docker.user` (10001:10001, the image's `jig` user); one that doesn't must run as that user. The task
folders are on the host's disk with no quota of their own: put `dataDir` on a file system of its own.

### The Kubernetes runner

`"runner": "kubernetes"` makes each task a `batch/v1` Job, through the API server with the service
account's token (read again at each request, as the kubelet renews it) and CA, from
`/var/run/secrets/kubernetes.io/serviceaccount/` unless `tokenFile`, `caFile`, `namespace` and `apiUrl`
say otherwise. The Job is named `jig-<task id>`; its pod runs once (`backoffLimit: 0`), as uid 10001 with
no privilege escalation, no capabilities, a read-only root, seccomp's `RuntimeDefault`, no service account
token and `runtimeClassName` if one is set (`gvisor`, with `deploy/k8s/runtimeclass.yaml`); the Job's
`activeDeadlineSeconds` is the task's time limit and the grace, and `ttlSecondsAfterFinished` (600) how long
it stays after. A Secret the Job owns, so deleted with it, holds the task's token, which jig gets as its
key, and the prompt and workspace.

```json
"runner": "kubernetes",
"kubernetes": { "image": "registry.example.com/jig-worker:0.1.0", "runtimeClassName": "gvisor",
  "resources": { "requests": { "cpu": "250m", "memory": "1Gi" }, "limits": { "cpu": "1", "memory": "2Gi", "ephemeral-storage": "4Gi" } } }
```

A pod's files are on its node, out of the service's reach, so the events come in its log: the pod runs
`node server/worker.ts`, which makes the workspace (writing the files, or cloning the repository there),
starts `jig --no-sandbox ... --events -` with the prompt on stdin, and after jig's events prints a line
with its exit code and `--stats`. The service follows the log (from the start again, without the events
it has, should the stream break, and any line over 1 MiB, which only the task's commands would write) and
takes the exit code from the pod, the stats from that line and a
reason from the Job: past its deadline the task is `stopped` (`time_limit`), out of memory an `error` that
says so, and a pod that never started (its image couldn't be pulled, say) an `error` with the pod's
reason, at the deadline. A cancel deletes the Job with `propagationPolicy: Background`, which takes its pod
and Secret with it.

`deploy/k8s/networkpolicy.yaml` lets the task pods reach only the gateway, the service's internal listener
(`jig-api-internal`, on its own port) and the cluster's DNS, where the
cluster's network plugin enforces NetworkPolicy. A git workspace is cloned in the pod, so it needs its git
host allowed as well (the file has an example rule).

### Warm pools

A Docker or Kubernetes task waits for its container or pod to be made, scheduled and started, its image
pulled, before jig's first model call: seconds, or minutes under load. With a pool, each replica keeps
workers started ahead of tasks (`server/pool.ts`), and a task that finds one waiting starts at once:

```json
"docker": { "image": "jig-worker", "network": "jig-tasks", "pool": { "size": 4, "maxIdleSeconds": 600 } }
```

`size` (0, no pool, by default) is how many idle workers the replica keeps; `pool` goes in the
`kubernetes` block the same way. A worker is a container (`docker.worker`, `node
/opt/jig/server/worker.ts` by default, with `--pool <internalBaseUrl>`) or a Job made as a task's is, the
same image, user, limits, network and runtime, with a ticket of its own in `JIG_POOL_TICKET`: 32 random
bytes, which the replica keeps only as their hash, with their expiry. The worker long-polls `POST
/internal/pool/claim` on the internal listener with the ticket as its Bearer, which spends it: a second
use is 401, and an expired ticket 410. When the scheduler starts a task and a worker waits, the task is
given to it in the answer to its claim, with what a cold start would have given it: the prompt, the
workspace, the task's gateway token and jig's arguments. On Docker the service makes the workspace in the
worker's own folder, bound at `/task` since the container started, and reads the events file there; on
Kubernetes the worker makes it, and the events come in the pod's log, its Job given the task's deadline
(from now) and labels with a merge patch (the Role in `deploy/k8s/rbac.yaml` allows `patch` on Jobs).
With none waiting the task starts cold, as before, and the pool is filled behind it. A miss is logged,
with the pool's idle workers, hits and misses so far.

A worker runs one task and exits: none is used again, so no tenant's files, memory or processes meet
another's, and what tenants share is what cold tasks share, the image and the node. The worker takes the
ticket out of its environment before it starts jig; spent, it opens nothing anyway. A worker idle for
`maxIdleSeconds` is told so (410) and stopped, and another started in its place; one that exits before it
claims is started again after a pause that doubles, up to a minute, so an image that can't run doesn't
loop; on Kubernetes, where only its claim says a worker is up, one that never claims is found at its
`maxIdleSeconds`. A service that stops stops its idle workers, and on Docker removes their folders
(`dataDir/tasks/pool_<hex>`) before it exits. A replica that crashes leaves them waiting on a connection
that breaks, and they exit (an idle Job's own deadline is `maxIdleSeconds` and a minute); their folders
stay, as a running task's does, since replicas may share `dataDir` and another's may be in use.

A worker claims from the replica that started it, which alone holds its ticket. `pool.baseUrl` is that
replica's internal listener as its workers reach it, the service's `internalBaseUrl` by default; on
Kubernetes that is a Service in front of every replica, so each replica takes its pod's own address from
`JIG_POOL_BASE_URL`, which `deploy/k8s/api.yaml` sets (`http://$(POD_IP):8082`) and which takes the
config's place.

## Events

`jig --events <file|->`, in a task given on the command line or stdin, writes the task's events as JSON
lines as it runs, one write each, so a crash loses at most the last: the contract between jig and
whatever runs it (here, the runners). Each line is `{"v": 1, "seq": n, "ts": "<ISO time>", "type": ...}`:

| type | fields |
|------|--------|
| `start` | `task`, `cwd`, `model`, `version`, `limits: {maxSteps, timeLimit}` |
| `step` | `step`, `usage: {input, cacheRead, cacheWrite, output}`, `cost` (null for an unpriced model) |
| `text` | `step`, `text`: each reply's text as a whole |
| `tool_call` | `step`, `id`, `name`, `description` |
| `tool_result` | `step`, `id`, `isError`, `output` (at most 4,000 characters, cut from the middle), `truncated` |
| `notice` | `text`: what jig told the user |
| `approval_request` | `step`, `id` (`ap_1`, `ap_2`, ...), `tool`, `description`: a tool call put to the approver (`--approve-via`'s service, or a library's `approve`) |
| `approval` | `id`, `decision` (`allow` or `deny`), `always`, `by`: `api` when answered, `timeout` when `--approval-timeout` passed first |
| `end` | `stop`, `exitCode` (as the process exits), `steps`, `usage` and `cost` of every model call, `seconds` |

Secrets are blanked out of every string, as `jig sessions export` does. With `-` the events are all that
goes to stdout: the terminal's output goes to stderr.

`jig --approve-via <url>` asks for the tool calls the mode would ask about at a terminal over HTTP: after the
call's `approval_request` it polls `GET <url>/<id>?wait=25` with `Authorization: Bearer <its API key>` (a
task's gateway token) until a 200 gives `{"decision": "allow" | "deny", "always"?: boolean}`; a 204 is asked
again at once, any other status or a failed connection after 1, 2, 4 ... seconds, 10 at most. With no
answer in `--approval-timeout` seconds (600) the call is denied. Both event types are additions to version 1:
`v` stays 1. A task stopped while it waits (by `--time-limit`, a signal or a cancel) writes no `approval`.

A program can also run a task in its own process with `runTask` (`src/lib.ts`, the README's "As a
library"), which hands it these events as objects, in the same order and with the same fields, and resolves
to the end's fields and the final reply's text; an `AbortSignal` stops it, and a callback answers the tool
calls the CLI would ask about. Several run at once in one process, each with its own jig directory and
commands' environment. The runners above still start jig as a process for each task.

## Model gateway

`server/gateway.ts` stands between jig and the provider. A task gets a token instead of an API key; the
gateway checks it, puts a real key from its pool in its place, and passes the request on and the reply
back. It is the service form of `eval/key_proxy.py`, which does the same for one key on Terminal-Bench.

```bash
export JIG_GATEWAY_SECRET=...            # shared with the task service, which signs the tokens
export ANTHROPIC_KEY_1=sk-ant-... ANTHROPIC_KEY_2=sk-ant-...
node server/gateway.ts --config gateway.json

# a task, as the task service runs it
ANTHROPIC_API_KEY=<the task's token> jig --model claude-opus-5-5 --base-url http://127.0.0.1:8081/anthropic "..."
```

```json
{
  "listen": { "host": "127.0.0.1", "port": 8081 },
  "metrics": { "port": 9091 },
  "upstream": { "baseUrl": "https://api.anthropic.com", "keyEnv": ["ANTHROPIC_KEY_1", "ANTHROPIC_KEY_2"] },
  "limits": {
    "concurrent": 64,
    "requestsPerMinute": 2000,
    "maxWaitMs": 30000,
    "tenantDefaults": { "requestsPerMinute": 60, "concurrent": 8 },
    "tenants": { "acme": { "requestsPerMinute": 600, "burst": 100, "concurrent": 32, "dailyUsd": 50, "monthlyUsd": 1000 } }
  },
  "adminTokenEnv": "JIG_GATEWAY_ADMIN_TOKEN"
}
```

`upstream.baseUrl` is the provider's Anthropic-compatible address (`https://api.deepseek.com/anthropic`
for DeepSeek, with `--model deepseek-...` and the token in `DEEPSEEK_API_KEY`), and `keyEnv` names the
environment variables that hold its keys. Only `upstream` (or `upstreams`, below: several providers to
fail over between) is required; `state` (below) lets several gateways run as one.

**Tokens.** A task's token is `"jgt1." + base64url(payload) + "." + base64url(HMAC-SHA256(secret,
"jgt1." + base64url(payload)))`, where the payload is `{"tenant": id, "task": id, "exp": <Unix seconds>,
"budgetUsd": <number or null>}` and the secret is `JIG_GATEWAY_SECRET`. `server/token.ts` mints and
verifies them. The gateway takes one in `x-api-key` or `Authorization: Bearer`, compares the signature in
constant time, and answers 401 to anything else, expired tokens included, without calling the provider.

**Routes.** `POST /anthropic/v1/messages` goes to the provider's `/v1/messages`, with the query as it came.
The body goes byte for byte, since prompt caching depends on it, and the headers as they came, but for the
credentials and `accept-encoding`: the gateway asks for the reply uncompressed, so it can read the usage in
it. A streamed reply comes back event by event as the provider sends it; if the provider breaks it off,
the gateway breaks off its own, so jig asks again at once. `GET /healthz` answers `ok`, without a token,
so keep the gateway's address inside the cluster; the metrics are on a listener of their own (below).
`GET /usage/<task>` gives what a task
spent, `{task, tenant, requests, usage, costUsd, unpriced, upstreams, budgetUsd}` (`upstreams`: the
replies counted, by the upstream that gave them), to that task's token (its tenant's task of that id), or
to the admin token (`adminTokenEnv`) with the tenant named, `/usage/<task>?tenant=<tenant>`, since a task id is only unique
within its tenant. `GET /usage?tenant=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD`, to the admin token alone, gives a
tenant's spending by UTC day, for billing: `{tenant, from, to, days: [{day, requests, input, output,
cacheRead, cacheWrite, costUsd}], total}`, both days in, the days with nothing spent left out. A range is
366 days at most, and a day that isn't one (`2026-02-30`), or `from` after `to`, is a 400; days are kept
35 days (below), so an older one reads as nothing spent.

**Limits.** Each tenant has a rate (`requestsPerMinute`, a token bucket refilled continuously, holding
`burst` requests, by default a minute's worth) and a number of requests in flight (`concurrent`, a
streamed reply counting until it ends); `tenants` sets them per tenant, `tenantDefaults` for the rest, and
the same fields at the top of `limits` hold for all tenants together, where `concurrent` is the most the
gateway sends upstream at once. Any left out is no limit. A request over a limit waits for its turn in a
queue that serves the tenants in turn, a request of each, so a tenant with a thousand requests waiting
delays another tenant's request by one slot at most. After `maxWaitMs` (30 seconds by default) it gets 429
with `retry-after`, and jig's SDK waits that long and tries again, twice at most.

**Quotas.** `dailyUsd` and `monthlyUsd`, in `tenantDefaults` or a tenant's own entry in `tenants` (not at
the top of `limits`, and above 0 where given), are the most a tenant may spend in a UTC day and in a UTC
month, across all its tasks. Before a request waits for its slot, the gateway reads what the tenant has
spent today and this month; at or past either quota it answers 402 (`billing_error`) at once, the
provider not called, with a message naming the quota, its amount, what is spent and when it resets
(00:00 UTC of the next day, or of the next month), and `retry-after` in seconds until then. jig's SDK
doesn't retry a 402, so the jig run ends with an error, as for a budget. The check is soft by the requests
already in flight: they finish and are counted when their replies end, so a tenant can go past a quota by
what they cost. A tenant with a quota may only use a priced model (400 otherwise), as a task with a budget.
Refusals are counted in `jig_gateway_refused_total` with `reason="quota"`. The task service checks the
same quotas when a task is posted, so a tenant past one has its new tasks refused before they queue; the
gateway's check, on every model call, is the hard limit on what a tenant spends.

**Keys.** The pool's keys are used in turn. A key the provider refuses (401 or 403) is not used again
until a restart (with `state`, below, until its mark in Redis is gone), and one it rate-limits (429)
rests for the reply's `retry-after` (30 seconds without one); either way the request goes again with
another usable key, once each. With none left the provider's 429 goes back to jig
as it came, and while every key rests the gateway answers 429 itself: it doesn't retry on its own, so a
rate limit doesn't become a storm. Server errors go back as they came, and jig's SDK retries them; with
`upstreams`, both first go on to the next provider (below).

**Provider failover.** One provider is a single point of failure: when it is down or overloaded, every
task of every tenant fails at once, and jig's few retries help against a blip, not an outage. In place of
`upstream`, `upstreams` lists several, in the order a request tries them (giving both is an error):

```json
"upstreams": [
  { "name": "anthropic", "baseUrl": "https://api.anthropic.com", "keyEnv": ["ANTHROPIC_KEY_1", "ANTHROPIC_KEY_2"],
    "models": { "claude-opus-5-5": "claude-opus-5-5", "claude-sonnet-5-5": "claude-sonnet-5-5" } },
  { "name": "anthropic-eu", "baseUrl": "https://anthropic.eu.example.com", "keyEnv": ["ANTHROPIC_EU_KEY"],
    "models": { "claude-opus-5-5": "claude-opus-5-5", "claude-sonnet-5-5": "claude-sonnet-5-5" } },
  { "name": "deepseek", "baseUrl": "https://api.deepseek.com/anthropic", "keyEnv": ["DEEPSEEK_API_KEY"],
    "models": { "deepseek-flash": "deepseek-flash", "deepseek-v4-pro": "deepseek-v4-pro" } }
],
"failover": { "firstByteMs": 60000, "failures": 5, "openMs": 30000 }
```

`name` (`a-z`, `0-9` and `-`, 32 at most, each its own) is what the reply's `x-jig-upstream` header,
`/usage` and the metrics call it; `upstream` alone is one named `default`. An upstream with `models` serves
only those models, each under the provider's id (the request's `model` is changed to it, the rest of the
body is sent as it came); one without serves any model as it is. Here a Claude model goes to `anthropic`,
then, if that fails, to `anthropic-eu` (another Anthropic endpoint, with keys of its own), and never to
DeepSeek; a DeepSeek model goes to `deepseek` alone. A model no upstream serves gets 400
(`invalid_request_error`) without a provider being called.

A request goes on to the next upstream that serves its model when the one it tried can't be reached,
sends no reply's headers within `firstByteMs`, answers 500, 502, 503, 504 or 529, or rate-limits it (429)
with no key of its pool left to try, or has every key refused; all of these before any of a reply has
gone to jig. A reply that breaks off once it streams is jig's to retry, as with one upstream, since what
jig has seen can't be taken back; and a 400, 404, 413 or other 4xx goes back as it came, since a bad
request is bad everywhere. The body is already held in memory, so it can be sent again. When every
upstream fails, the last failed reply goes back as it came (a 429 with its `retry-after`), or 503
(`overloaded_error`) if none answered.

Each upstream has a circuit breaker, each replica its own: `failures` failures in a row (those that send
a request on, but not a 429 or a pool with every key resting or refused, since a rate-limited key rests
for its own `retry-after` and no longer; a 400 that goes back to jig is the upstream answering) open it,
and for `openMs` it is passed over, no request reaching it. Then one request at a time tries it; its reply closes the circuit,
its failure opens it for another `openMs`. With every upstream for a model open, the gateway answers 503
at once, with a `retry-after` for when one may be tried. The gateway says on stderr when an upstream is passed over and when it answers again.

Usage is priced by the model the reply names, or else the provider's id where `src/prices.ts` has a price
for it, or else the model jig asked for; budgets hold as with one upstream.

**Metrics and logs.** With `"metrics": {"host": "127.0.0.1", "port": 9091}` (`host` defaults to
127.0.0.1), a second listener answers only `GET /metrics`, in Prometheus's text format, and `GET /healthz`;
without the block there is none, and the public port never serves metrics. Each replica counts its own:

| metric | labels | what |
|--------|--------|------|
| `jig_gateway_requests_total` | `tenant`, `upstream`, `status` | model calls by their final status (499 when jig went away first), and the upstream whose reply went back (`none` when none answered; `tenant` is `none` for a token that fails) |
| `jig_gateway_request_seconds` | `upstream` | histogram: from a call's arrival to its reply's end |
| `jig_gateway_first_byte_seconds` | `upstream` | histogram: from a call's arrival to the headers of the provider's reply passed back |
| `jig_gateway_queue_seconds` | `tenant` | histogram: how long a call waited for a slot under the limits |
| `jig_gateway_inflight` | `tenant` | gauge: calls let through whose reply is not over |
| `jig_gateway_waiting` | | gauge: calls waiting for a slot on this replica |
| `jig_gateway_tokens_total` | `tenant`, `kind` | tokens, `kind` being `input`, `output`, `cache_read` or `cache_write` |
| `jig_gateway_cost_usd_total` | `tenant` | what the priced replies cost |
| `jig_gateway_failovers_total` | `from`, `to`, `reason` | calls an upstream failed, `to` the next one tried (`none` with none left), `reason` one of `connect`, `timeout`, `status_<code>` or `keys` |
| `jig_gateway_upstream_open` | `upstream` | gauge: 1 while its circuit is open or half-open |
| `jig_gateway_keys` | `upstream`, `state` | gauge: how many keys are `ok`, `resting` or `refused` |
| `jig_gateway_refused_total` | `tenant`, `reason` | calls the gateway turned away itself: `auth`, `budget`, `rate`, `concurrency` or `quota` |
| `jig_gateway_state_errors_total` | | reads and writes of Redis that failed |

No label holds a key, a token, a prompt or a task. Every reply carries `x-request-id`: the client's, if it
sent one of 1 to 128 letters, digits, `_`, `.` and `-`, or else a new one. It isn't sent to the provider.
The gateway logs on stderr, as `jig gateway: ...` lines or, with `JIG_LOG_FORMAT=json`, one JSON object a
line; `JIG_LOG_LEVEL=debug` adds a line for each model call, with its `request`, `tenant`, `task`,
`upstream`, `status`, `ms`, `input` and `output` tokens, `cost`, and `upstream_request`, the provider's own
`request-id` for the reply. A slow or failed call is found by its task or
request id and followed to the provider; an error the gateway itself meets is logged at `error`, with its
request id.

**Usage and budgets.** The gateway reads each reply's usage as it passes (a whole reply's `usage`, or a
stream's `message_start` and `message_delta`), also of a stream jig left halfway, and adds it to the task's
and the tenant's totals, priced by `src/prices.ts`. A model without a price there counts its tokens but no
cost (`unpriced`). Spending is kept by tenant and task, so two tenants' tasks of the same id are two
tasks, and jig's reply ends only once it is counted. A task whose spending has reached its token's
`budgetUsd` gets 402 (`billing_error`) on its next request, which ends the jig run with an error (a budget
of 0 refuses the first); requests already in flight finish, so a task can go over by what they cost. A
task with a budget may only use a priced model: one without a price gets 400, since its spending couldn't
be counted against the budget. Each tenant's spending by UTC day and by UTC month is kept too, for quotas
and billing to read. Without `state`, all this is in the gateway's memory: a task is forgotten a day after
its token expires, a tenant's day 35 days after its last reply, its month 400 days after, and a restart
forgets everything.

**Several replicas.** With `state`, the gateway keeps its counts in Redis, so any number of replicas
behind one Service act as one gateway, and a restart forgets nothing:

```json
"state": { "redis": "redis://:password@redis:6379/0", "prefix": "jig:gw:", "leaseMs": 60000, "onStateError": "closed" }
```

`redis` is `redis://[[username]:password@]host:port[/db]` (`rediss://` for TLS); `server/redis.ts` is a
small client of its own, with no dependency. Each check and change is one Lua script, run atomically by
Redis on its own clock. A tenant's and the global rate buckets and requests in flight hold across all
replicas; a request in flight is a lease that its gateway renews every `leaseMs`/3 while the reply goes
on, so the slots of a replica that died come back within `leaseMs` (60 seconds). The queue that takes the
tenants in turn is each replica's own: a replica that gives back a slot says so on a Redis channel, and
the others' waiting requests try again at once, and every 250 ms anyway. A task's spending is kept until a
week after its token expires, a tenant's day for 35 days and its month for 400 (a hash each,
`<prefix>day:<tenant>:<YYYY-MM-DD>` and `<prefix>month:<tenant>:<YYYY-MM>`, added to in the same script); a key the provider refused or rate-limited is
passed over by every replica (Redis has its SHA-256, never the key), a rate-limited one until its rest is
over, and a refused one for a day after it was last refused, restarts or not. Each key's mark is its own
Redis key, `<prefix>key:<id>`, `id` being the first 16 hex digits of the key's SHA-256. To have the
replicas try a key you put right before the day is over, delete its mark:
`redis-cli DEL "jig:gw:key:$(printf %s "$KEY" | sha256sum | cut -c1-16)"`. A replaced key has another
hash, so it is used at once. `prefix` (`jig:gw:`) starts every key, so gateways of different setups can
share a Redis.

When Redis can't be reached (a command waits 2 seconds at most), `onStateError` says what happens:
`closed`, the default, answers each request 503 with `retry-after: 1` (jig's SDK tries again), and the
spending of replies still in flight goes uncounted; `open` goes on with this replica's own limits and
counts until Redis is back, so for that while each replica holds a tenant to its limits alone, and budgets
and quotas count only what went through it. Either way the gateway says so once on stderr and counts each failure in
`jig_gateway_state_errors_total`.

## Several regions

One deployment is one region: tenants far from it wait on every request, its outage stops them all, and a
tenant whose data must stay in the EU can't be sure it does. So each region runs a whole stack of its own,
as above (the service's replicas, their Postgres, the gateway and its Redis, the runners), and a router,
`server/router.ts`, sends each tenant's requests to the region they belong in. In front of the routers,
which keep nothing, goes GeoDNS or a global load balancer, so a client reaches the nearest.

**Regions.** A service with `"region": "eu"` (1 to 16 lowercase letters and digits) gives its new tasks
ids that say so, `task_eu_<32 hex digits>`; one without makes `task_<32 hex digits>`, as before. Its `GET
/healthz` is `{"ok": true, "region": "eu"}` (`null` without one), a task's view has `region`, and a task
posted with `"region"` is made only if that is its own region: any other is 400, `this is region eu; post
to region us's service or through the router`. What is per region stays there: the database (tasks, their
events and approvals), the workspaces, the runners' containers and pods, and the gateway with its
spending and limits, which may itself fail over from one provider to another. No task's data is copied to
another region, by design: that is what keeps a tenant's data where it was put.

**The router.** `node server/router.ts --config router.json` (`deploy/router.json`):

```json
{
  "listen": { "host": "0.0.0.0", "port": 8090 },
  "metrics": { "host": "0.0.0.0", "port": 9090 },
  "regions": [{ "name": "eu", "url": "https://jig-eu.example.com" }, { "name": "us", "url": "https://jig-us.example.com" }],
  "tenants": [{ "id": "acme", "keys": ["<sha256 of its key>"], "home": "eu", "allowed": ["eu", "us"], "failover": true }],
  "health": { "intervalMs": 5000, "failures": 2 }
}
```

`regions` are the regions' services' public URLs, each named as that service's `region`. Each tenant has
the key hashes the regions have for it, its `home` region, the regions its tasks may be in (`allowed`, its
home alone by default) and `failover` (false). The router maps a request's key to its tenant (401, as a
service's, for one it doesn't know) and passes the request on, `Authorization` and all, so the region's
service still checks the key; of what a tenant sends, it reads only a new task's `region` (in a body of
16 MiB at most). Every answer has `x-jig-region`, the region that gave it, and `x-request-id`, the
client's if it sent one (`^[\w.-]{1,128}$`) or a new one, which the region is sent too.

- `POST /v1/tasks` goes to the spec's `region` if it names one (403 if the tenant may not use it), else to
  the home. The body goes as it came.
- `/v1/tasks/<id>` and what is under it (events, cancel, approvals) go to the region in the id: 404 for a
  region the router doesn't know or the tenant may not use; an id without one goes to the home. A stream
  of events is passed on as it comes, and a client that leaves it closes the request to the region.
- `GET /v1/tasks` and `GET /v1/usage` go to `?region=` (the home by default). `GET /v1/usage?region=all`
  asks every region the tenant may use and adds up their answers, the rows with the same day and model and
  the total, with `regions`, those that answered (502 if none did); it is JSON only.
- Anything else goes to the home.

**Health and failover.** The router asks each region's `/healthz` every `intervalMs`; one that fails
`failures` times in a row (no answer in 2 seconds, not 200, or another region's name) is down until it
answers again. While a tenant's home is down, a new task that names no region goes, if the tenant has
`failover`, to the first region in `regions` that is up and that it may use; otherwise, and for a task that
names the region that is down, it is 503 with the region and `retry-after`. A task never fails over: it
runs where it was made, and while its region is down it can't be read, streamed or cancelled (503), since
its data is there alone; it is all there once the region is back. A tenant is placed by its `home`, where
its tasks and their data go unless it asks otherwise; one whose data must stay in a region gets that
region alone in `allowed`, and no failover.

`GET /healthz` is `{"ok": true, "regions": {"eu": true, "us": false}}`. With `metrics`, a listener of its
own (127.0.0.1 by default) serves `GET /metrics` and `GET /healthz` only: `jig_router_requests_total` by
region (empty for the router's own answers, `all` for usage added up), route and status, `jig_router_request_seconds` (to the
answer's headers) by region and route, `jig_router_region_up` by region, and `jig_router_failovers_total`
by `from` and `to`. The router keeps nothing between requests, so any number of replicas can run,
anywhere; `deploy/k8s/router.yaml` runs two.

## Deploying

`deploy/` has the images and the files to run them, to adapt rather than apply as they are:
`Dockerfile.worker`, the image tasks run in (jig, git, python3 and bubblewrap, as user 10001), and
`Dockerfile.server`, the service's and the gateway's (with the docker CLI). On one machine,
`deploy/docker-compose.yml` runs the service, with the host's docker socket and the Docker runner
(`deploy/service.docker.json`), and the gateway, on the internal `jig-tasks` network the tasks join; the
gateway's config is `deploy/gateway.json` (DeepSeek, its key in `DEEPSEEK_API_KEY`). On Kubernetes,
`deploy/k8s/` has the namespace, the service's and the gateway's Deployments and Services, the service's
account with a Role to run Jobs, the tasks' account with none, the NetworkPolicy, a gVisor RuntimeClass and
the service's config; the gateway's config (`jig-gateway-config`) is beside the service's, and the Secrets
(`jig-secrets` with `gateway-secret`, `jig-database` with `url`, the Postgres URL, and `jig-provider-keys`)
are yours to make. The service runs two replicas on that database. The gateway runs two replicas too,
sharing the Redis in `deploy/k8s/redis.yaml`, which has no disk of its own: its restart forgets the counts,
as a lone gateway's restart would. For spending that must last, use a managed Redis instead, or give that
one a volume and `--appendonly yes`, and set its URL in the gateway's config. The Compose file runs one
gateway, with a Redis that keeps its data in a volume, so a restart of either forgets nothing.
