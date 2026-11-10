import { Registry } from "./metrics.ts";

// What the task service tells Prometheus (docs/server.md, Metrics and logs): its requests, its tasks from
// created to ended, the warm pools, the approvals, the errors of its leases and its store, and what the
// tasks spent. A label is never a key, a token, a prompt or a task's id: tenant, status and route are.

/** The routes of the API as their requests are counted: templates, never a task's id. */
export const ROUTES = ["/v1/tasks", "/v1/tasks/:id", "/v1/tasks/:id/events", "/v1/tasks/:id/cancel", "/v1/tasks/:id/approvals", "/v1/tasks/:id/approvals/:aid", "/v1/usage", "/v1/limits", "/admin/usage", "/healthz", "/readyz", "other"];

/**
 * The route a request's path is counted under. The probes have their own: a /readyz that answers 503 while
 * the database is down isn't a request of a tenant's that failed (JigApiErrors leaves them out).
 */
export function routeOf(path: string): string {
  if (["/v1/tasks", "/v1/usage", "/v1/limits", "/admin/usage", "/healthz", "/readyz"].includes(path)) return path;
  const match = /^\/v1\/tasks\/[\w-]+(\/cancel|\/events|\/approvals(\/[\w-]{1,100})?)?$/.exec(path);
  if (!match) return "other";
  return `/v1/tasks/:id${match[2] ? "/approvals/:aid" : (match[1] ?? "")}`;
}

/** The service's metrics, in a registry of their own: each service started in a process has its own. */
export function serviceMetrics(registry = new Registry()) {
  const metrics = {
    registry,
    httpRequests: registry.counter("jig_service_http_requests_total", "Requests to the API, by route and status.", ["route", "status"]),
    httpSeconds: registry.histogram("jig_service_http_request_seconds", "Seconds from a request to the end of its response (an event stream's lasts as long as it is followed), by route.", ["route"]),
    created: registry.counter("jig_service_tasks_created_total", "Tasks created, by tenant.", ["tenant"]),
    ended: registry.counter("jig_service_tasks_ended_total", "Tasks this replica ended, by tenant and status.", ["tenant", "status"]),
    refused: registry.counter("jig_service_tasks_refused_total", "Tasks refused, by tenant and reason: queue (maxQueued), quota or invalid.", ["tenant", "reason"]),
    tasks: registry.gauge("jig_service_tasks", "Tasks queued and running in the store (all replicas'), by tenant and status.", ["tenant", "status"]),
    oldestQueued: registry.gauge("jig_service_queue_oldest_seconds", "Seconds the oldest queued task of each tenant has waited, in the store.", ["tenant"]),
    queueSeconds: registry.histogram("jig_service_queue_seconds", "Seconds from a task's creation to its start, for the tasks this replica started."),
    runSeconds: registry.histogram("jig_service_run_seconds", "Seconds from a task's start to its end, by status.", ["status"]),
    startSeconds: registry.histogram("jig_service_start_seconds", "Seconds from a task's start to jig's first event, on a warm worker or a cold start.", ["start"]),
    poolIdle: registry.gauge("jig_service_pool_idle", "Warm workers waiting for a task on this replica."),
    poolTakes: registry.counter("jig_service_pool_takes_total", "Tasks started with a warm pool, by whether a warm worker took them (hit) or they started cold (miss).", ["result"]),
    approvalsPending: registry.gauge("jig_service_approvals_pending", "Approvals of running tasks waiting for an answer, in the store."),
    approvalWait: registry.histogram("jig_service_approval_wait_seconds", "Seconds from an approval's request to its answer, by decision: allow, deny or timeout.", ["decision"]),
    webhookDeliveries: registry.counter("jig_service_webhook_deliveries_total", "Approvals and task ends posted to tenants' webhooks, by tenant, kind (approval or task) and result: delivered, or failed once the last try failed (a task end past the cap of those waiting, at once).", ["tenant", "kind", "result"]),
    leaseErrors: registry.counter("jig_service_lease_errors_total", "Rounds of renewing this replica's leases that failed."),
    storeErrors: registry.counter("jig_service_store_errors_total", "Tries of reads and writes of the store that failed outside a request (starting tasks, storing their events and outcomes, following them), by whether the try was retried: true, or false when it was given up on.", ["retried"]),
    replicas: registry.gauge("jig_service_replicas", "Replicas of the service whose heartbeat is in the store."),
    cost: registry.counter("jig_service_cost_usd_total", "USD the tasks this replica ended spent, by tenant, from their end events.", ["tenant"]),
    tokens: registry.counter("jig_service_tokens_total", "Tokens the tasks this replica ended used, by tenant and kind, from their end events.", ["tenant", "kind"]),
    foldersRemoved: registry.counter("jig_service_task_folders_removed_total", "Folders that runs left on this machine for tasks that ended long ago, or that the store doesn't have, which this replica removed (a crashed replica's)."),
    dbPool: registry.gauge("jig_service_db_pool_connections", "This replica's connections to Postgres, by state: open (in use or idle), idle, and waiting (queries waiting for one).", ["state"]),
    eventStreams: registry.gauge("jig_service_event_streams", "Event streams open on this replica, by tenant.", ["tenant"]),
  };
  // At 0 from the start, so increase() counts the first of each: a failure, or the folders the sweep at start
  // removes before the first scrape.
  for (const retried of ["true", "false"]) metrics.storeErrors.inc({ retried }, 0);
  metrics.leaseErrors.inc({}, 0);
  metrics.foldersRemoved.inc({}, 0);
  return metrics;
}

export type ServiceMetrics = ReturnType<typeof serviceMetrics>;
