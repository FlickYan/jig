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
to none and `maxQueued` (its tasks that may wait at once) to 1000. The config holds only the SHA-256 of
each key: `printf %s "$KEY" | sha256sum` gives it. A tenant taken out of the config is shut out at the next
start: its keys stop working, and its queued tasks are cancelled. Also: `graceSeconds` (30), `jig` (the program and first
arguments that start jig: this checkout's `src/cli.ts` by default), `gitProtocols` (`["https"]`),
`maxBodyBytes` (1 MiB) and `heartbeatSeconds` (15), and `runner`: `local` (the default), `docker` or
`kubernetes`, with its settings in a `docker` or `kubernetes` block.

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
over `maxBodyBytes`; with 429 when the tenant already has `maxQueued` tasks queued. A cancel answers 200 for a queued task (it is cancelled at once), 202 for a running
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
another's one. It reads only the next task of the tenant whose turn it is, never the whole queue, so a
long queue doesn't slow the service. A task is claimed in the store (`queued` to `running`) before it starts, so it never runs
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

The network must reach only the gateway: an internal network (`docker network create --internal
jig-tasks`) with the gateway attached to it too (`docker network connect jig-tasks <gateway>`), so the
tasks reach it by its name there (`"gatewayBaseUrl": "http://gateway:8081/anthropic"`) and nothing else.
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

`deploy/k8s/networkpolicy.yaml` lets the task pods reach only the gateway and the cluster's DNS, where the
cluster's network plugin enforces NetworkPolicy. A git workspace is cloned in the pod, so it needs its git
host allowed as well (the file has an example rule).

## Deploying

`deploy/` has the images and the files to run them, to adapt rather than apply as they are:
`Dockerfile.worker`, the image tasks run in (jig, git, python3 and bubblewrap, as user 10001), and
`Dockerfile.server`, the service's and the gateway's (with the docker CLI). On one machine,
`deploy/docker-compose.yml` runs the service, with the host's docker socket and the Docker runner
(`deploy/service.docker.json`), and the gateway, on the internal `jig-tasks` network the tasks join; the
gateway's config goes in `deploy/gateway.json`. On Kubernetes, `deploy/k8s/` has the namespace, the
service's and the gateway's Deployments and Services, the service's account with a Role to run Jobs, the
tasks' account with none, the NetworkPolicy, a gVisor RuntimeClass and the service's config; the Secrets
(`jig-secrets` with `gateway-secret`, and `jig-provider-keys`) and the gateway's config
(`jig-gateway-config`) are yours to make. The service runs one replica, as its SQLite store takes one
writer, and so does the gateway, which counts limits and spending in memory.
