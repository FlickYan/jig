# jig behind a backend

jig is a terminal agent; this is how it runs as a service, many tasks at once for many tenants. The code
is in `server/`, TypeScript that Node runs directly as it runs `src/`, with no dependencies beyond jig's.
It isn't part of the npm package.

- **Control plane**: the task service, which takes tasks over HTTP, keeps them in a store, and schedules
  them fairly across tenants.
- **Execution plane**: runners that start each task as a jig process in a workspace of its own (locally,
  in Docker, or as a Kubernetes Job), and stream its events back.
- **Model gateway**: what every task's model calls go through. It holds the provider's keys, so no
  sandbox does, and holds each tenant to its limits and each task to its budget.

It comes in three phases. Phase 1: the event protocol, the model gateway, the task service with its
queue and fair scheduler, and the Docker and Kubernetes runners. Phase 2: jig as a library, approvals
answered asynchronously, state kept outside the machine, warm pools. Phase 3: several regions, failover
between providers, quotas and billing, observability. Each part has its section below.

## Model gateway

`server/gateway.ts` stands between jig and the provider. A task gets a token instead of an API key; the
gateway checks it, puts a real key from its pool in its place, and passes the request on and the reply
back. It is the service form of `eval/key_proxy.py`, which does the same for one key on Terminal-Bench.

```bash
export JIG_GATEWAY_SECRET=...            # shared with the task service, which signs the tokens
export ANTHROPIC_KEY_1=sk-ant-... ANTHROPIC_KEY_2=sk-ant-...
node server/gateway.ts --config gateway.json

# a task, as the task service runs it
ANTHROPIC_API_KEY=<the task's token> jig --model claude-opus-5-5 --base-url http://127.0.0.1:8787/anthropic "..."
```

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "upstream": { "baseUrl": "https://api.anthropic.com", "keyEnv": ["ANTHROPIC_KEY_1", "ANTHROPIC_KEY_2"] },
  "limits": {
    "concurrent": 64,
    "requestsPerMinute": 2000,
    "maxWaitMs": 30000,
    "tenantDefaults": { "requestsPerMinute": 60, "concurrent": 8 },
    "tenants": { "acme": { "requestsPerMinute": 600, "burst": 100, "concurrent": 32 } }
  },
  "adminTokenEnv": "JIG_GATEWAY_ADMIN_TOKEN"
}
```

`upstream.baseUrl` is the provider's Anthropic-compatible address (`https://api.deepseek.com/anthropic`
for DeepSeek, with `--model deepseek-...` and the token in `DEEPSEEK_API_KEY`), and `keyEnv` names the
environment variables that hold its keys. Only `upstream` is required.

**Tokens.** A task's token is `"jgt1." + base64url(payload) + "." + base64url(HMAC-SHA256(secret,
"jgt1." + base64url(payload)))`, where the payload is `{"tenant": id, "task": id, "exp": <Unix seconds>,
"budgetUsd": <number or null>}` and the secret is `JIG_GATEWAY_SECRET`. `server/token.ts` mints and
verifies them. The gateway takes one in `x-api-key` or `Authorization: Bearer`, compares the signature in
constant time, and answers 401 to anything else, expired tokens included, without calling the provider.

**Routes.** `POST /anthropic/v1/messages` goes to the provider's `/v1/messages`, with the query as it came.
The body goes byte for byte, since prompt caching depends on it, and the headers as they came, but for the
credentials and `accept-encoding`: the gateway asks for the reply uncompressed, so it can read the usage in
it. A streamed reply comes back event by event as the provider sends it; if the provider breaks it off,
the gateway breaks off its own, so jig asks again at once. `GET /healthz` answers `ok`.
`GET /metrics` is Prometheus's text format: `jig_gateway_requests_total`, `jig_gateway_rate_limited_total`
and `jig_gateway_budget_exceeded_total` by tenant, `jig_gateway_upstream_errors_total` by status,
`jig_gateway_tokens_total` by tenant and kind, `jig_gateway_cost_usd_total`, and the gauges
`jig_gateway_in_flight` and `jig_gateway_queued`. Neither of those two GETs asks for a token, so keep the
gateway's address inside the cluster. `GET /usage/<task>` gives what a task spent, `{tenant, requests,
usage, costUsd, unpriced, budgetUsd}`, to that task's token or to the admin token (`adminTokenEnv`).

**Limits.** Each tenant has a rate (`requestsPerMinute`, a token bucket refilled continuously, holding
`burst` requests, by default a minute's worth) and a number of requests in flight (`concurrent`, a
streamed reply counting until it ends); `tenants` sets them per tenant, `tenantDefaults` for the rest, and
the same fields at the top of `limits` hold for all tenants together, where `concurrent` is the most the
gateway sends upstream at once. Any left out is no limit. A request over a limit waits for its turn in a
queue that serves the tenants in turn, a request of each, so a tenant with a thousand requests waiting
delays another tenant's request by one slot at most. After `maxWaitMs` (30 seconds by default) it gets 429
with `retry-after`, and jig's SDK waits that long and tries again, twice at most.

**Keys.** The pool's keys are used in turn. A key the provider refuses (401 or 403) is never used again,
and one it rate-limits (429) rests for the reply's `retry-after` (30 seconds without one); either way the
request goes again with another usable key, once each. With none left the provider's 429 goes back to jig
as it came, and while every key rests the gateway answers 429 itself: it doesn't retry on its own, so a
rate limit doesn't become a storm. Server errors go back as they came, and jig's SDK retries them.

**Usage and budgets.** The gateway reads each reply's usage as it passes (a whole reply's `usage`, or a
stream's `message_start` and `message_delta`), also of a stream jig left halfway, and adds it to the task's
and the tenant's totals, priced by `src/prices.ts`. A model without a price there counts its tokens but no
cost (`unpriced`). A task whose spending has reached its token's `budgetUsd` gets 402 (`billing_error`)
on its next request, which ends the jig run with an error; requests already in flight finish, so a task
can go over by what they cost. A task with a budget may only use a priced model: one without a price gets
400, since its spending couldn't be counted against the budget. Totals live in the gateway's memory, so a
restart forgets them; keeping them in a store is Phase 2's.
