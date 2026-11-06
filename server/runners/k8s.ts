import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createLog, type Log } from "../log.ts";
import { type PoolConfig, type Started, type Warm, WarmPool } from "../pool.ts";
import { type JigEvent, jigArgs, keyVariable, type RunExit, type RunHandle, type Runner, taskToken } from "../runner.ts";
import type { Task, Tenant } from "../store.ts";
import type { PoolAnswer, WorkerInput } from "../worker.ts";
import { Lines, parseEvent } from "./local.ts";

// Runs each task as a Kubernetes Job of its own, through the API server with the service account's
// token. The Job's one pod runs server/worker.ts in the worker image, which makes the workspace and starts
// jig with `--events -`, so the events come in the pod's log, which this follows: a pod's files are on its
// node, out of the service's reach, while its log is the API server's to give. The prompt, the workspace
// and the task's gateway token go in a Secret the Job owns, so they are deleted with it. With a pool, Jobs
// are started ahead of tasks, and a task is given to one whose worker waits (pool.ts): the worker gets the
// task in the answer to its claim, and its pod's log is followed as a task's own.

export interface KubernetesRunnerConfig {
  /** The API server (default: in the cluster, https://kubernetes.default.svc). */
  apiUrl?: string;
  /** The service account's token, read at each request, since the kubelet renews it. */
  tokenFile?: string;
  /** The CA that signed the API server's certificate. */
  caFile?: string;
  /** The namespace the Jobs go in (default: the service's own, from the service account's namespace file). */
  namespace?: string;
  /** The worker image (deploy/Dockerfile.worker). */
  image: string;
  /** The worker's entry point in the image (default: node /opt/jig/server/worker.ts), and jig (default: jig). */
  worker?: string[];
  jig?: string[];
  /** The RuntimeClass the pods run with (gvisor, say); the cluster's default without one. */
  runtimeClassName?: string;
  /** The pods' service account, which needs no permissions (default: jig-task); its token isn't mounted. */
  serviceAccountName?: string;
  /** The container's requests and limits, as Kubernetes takes them. */
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  /** How long a finished Job is kept, with its pod and log (default: 600 seconds). */
  ttlSecondsAfterFinished?: number;
  /** The uid and gid jig runs as (10001, the image's jig user). */
  user?: number;
  gatewayBaseUrl: string;
  gatewaySecret: string;
  graceSeconds: number;
  gitProtocols?: string[];
  /** The service's internal listener as the pods reach it (its Service): where tasks ask for approvals. */
  internalBaseUrl?: string;
  /** Workers started ahead of tasks (pool.ts): none unless `size` is set. */
  pool?: PoolConfig;
  /** How often the Job and its pod are looked at, in milliseconds (default: 1000). */
  pollMs?: number;
  /** Where the runner's pool and its warm hand-offs log (default: the service's log). */
  log?: Log;
}

const ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";
const RESOURCES = { requests: { cpu: "250m", memory: "1Gi", "ephemeral-storage": "1Gi" }, limits: { cpu: "1", memory: "2Gi", "ephemeral-storage": "4Gi" } };
/** The label the runner finds a task's pod by, and the one the deploy files' NetworkPolicy selects. */
export const TASK_LABEL = "jig.dev/task";
/** The label a warm worker's Job and pod are found by, until a task is given to it. */
export const POOL_LABEL = "jig.dev/pool";
export const ROLE_LABELS = { "app.kubernetes.io/name": "jig", "app.kubernetes.io/component": "task" };
// Where the pod keeps the task's input and folder, and how long it waits for the API server past the
// deadline the Job itself keeps, should the Job controller not stop it.
const INPUT = "/task-input";
const TASK = "/task";
const SLACK_MS = 60_000;
/** The most a Secret's data may hold, in bytes. */
const SECRET_BYTES = 1024 * 1024;
/** The longest a poll waits while a task's pod hasn't started yet, in milliseconds. */
const PENDING_POLL_MS = 5000;

/** A warm worker's Job: its name, where it is, when it was made, and the selector its pod is found by. */
interface Slot {
  job: string;
  ns: string;
  jobPath: string;
  created: number;
  selector: string;
}

/** A Kubernetes object, as much of it as the runner reads. */
interface Resource {
  metadata?: { name?: string; uid?: string; creationTimestamp?: string };
  status?: {
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    phase?: string;
    containerStatuses?: { state?: { running?: object; waiting?: { reason?: string; message?: string }; terminated?: { exitCode: number; reason?: string } } }[];
  };
  items?: Resource[];
  message?: string;
}

export class KubernetesRunner implements Runner {
  /** The workers started ahead of tasks, if the config asks for any. */
  readonly pool?: WarmPool<Slot>;
  private config: KubernetesRunnerConfig;
  private ca: Promise<Buffer> | undefined;
  private ns: Promise<string> | undefined;
  /** Where the warm workers claim their tasks. */
  private poolUrl = "";
  private log: Log;

  constructor(config: KubernetesRunnerConfig) {
    this.config = config;
    this.log = config.log ?? createLog("service");
    if (config.pool?.size) this.pool = new WarmPool(config.pool, (ticket) => this.launchWarm(ticket), this.log);
  }

  warm(internalBaseUrl: string): void {
    this.poolUrl = this.config.pool?.baseUrl ?? internalBaseUrl;
    this.pool?.open();
  }

  async claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.pool) return void res.writeHead(404, { "content-type": "application/json" }).end(`${JSON.stringify({ error: "This service keeps no warm workers" })}\n`);
    return this.pool.claim(req, res);
  }

  async close(): Promise<void> {
    await this.pool?.close();
  }

  /**
   * Deletes the Jobs a gone replica left running for the task, whichever replica asks: they carry its
   * label, its own Job and a warm worker's given it alike, and the API server is the same for all.
   */
  async abandon(id: string): Promise<void> {
    const ns = await this.namespace();
    const jobs = await this.call<Resource>("GET", `/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=${encodeURIComponent(`${TASK_LABEL}=${id}`)}`);
    for (const job of jobs?.items ?? []) if (job.metadata?.name) await this.remove(`/apis/batch/v1/namespaces/${ns}/jobs/${job.metadata.name}`);
  }

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    const warm = this.pool?.take(task.id);
    const handle = warm && (await this.startWarm(warm, task, tenant));
    if (handle) return handle;
    const { graceSeconds } = this.config;
    const ns = await this.namespace();
    const name = objectName(task.id);
    const jobPath = `/apis/batch/v1/namespaces/${ns}/jobs/${name}`;
    const command = [...this.worker(), `${INPUT}/task.json`, ...this.jigCommand(task, tenant)];
    const env = [{ name: keyVariable(task.spec.model), valueFrom: { secretKeyRef: { name, key: "token" } } }];
    const input: WorkerInput = { prompt: task.spec.prompt, workspace: task.spec.workspace, gitProtocols: this.config.gitProtocols ?? ["https"], work: `${TASK}/work`, stats: `${TASK}/stats.json` };
    const data = { token: taskToken(this.config.gatewaySecret, task, tenant, graceSeconds), "task.json": JSON.stringify(input) };
    // Checked before the Job is made, which the API server would otherwise make and the Secret then fail.
    const bytes = Object.values(data).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    if (bytes > SECRET_BYTES) throw new Error(`The task's prompt and workspace are ${bytes} bytes with its token, more than the 1 MiB a Kubernetes Secret holds`);
    const job = await this.call<Resource>("POST", `/apis/batch/v1/namespaces/${ns}/jobs`, this.job(name, taskLabels(task, tenant), command, env, task.spec.timeLimit + graceSeconds, true, tenantAnnotation(tenant)));
    // Made after the Job, whose uid it needs to be deleted with it; the pod waits for it to mount.
    await this.secret(ns, name, job, { [TASK_LABEL]: task.id }, data);
    return this.followed(ns, jobPath, `${TASK_LABEL}=${task.id}`, task);
  }

  /**
   * Runs the task on a warm worker: the Job's deadline moved to the task's time limit and the grace from
   * now, and the task, what a cold start puts in its Secret and command line, in the answer to its claim.
   * Undefined if the worker can't take it (it went away, or its Job couldn't be changed), and the task
   * starts cold.
   */
  private async startWarm(warm: Warm<Slot>, task: Task, tenant: Tenant): Promise<RunHandle | undefined> {
    const { graceSeconds } = this.config;
    const { job, ns, jobPath, created, selector } = warm.slot;
    // activeDeadlineSeconds counts from the Job's start, which is after `created`.
    const deadline = Math.ceil((Date.now() - created) / 1000) + task.spec.timeLimit + graceSeconds;
    try {
      await this.call("PATCH", jobPath, { metadata: { labels: taskLabels(task, tenant), annotations: tenantAnnotation(tenant) }, spec: { activeDeadlineSeconds: deadline } }, [], "application/merge-patch+json");
    } catch (err) {
      this.log.warn("couldn't give the task to a warm worker, which is stopped; the task starts cold", { task: task.id, err });
      warm.stop();
      return undefined;
    }
    const answer: PoolAnswer = {
      prompt: task.spec.prompt,
      workspace: task.spec.workspace,
      gitProtocols: this.config.gitProtocols ?? ["https"],
      work: `${TASK}/work`,
      stats: `${TASK}/stats.json`,
      command: this.jigCommand(task, tenant),
      env: { [keyVariable(task.spec.model)]: taskToken(this.config.gatewaySecret, task, tenant, graceSeconds) },
      report: true,
    };
    if (!warm.answer(answer)) return undefined;
    // The Job has the task's labels now, but its pod keeps the pool's: this says which pod is the task's.
    this.log.info("the task runs on a warm worker", { task: task.id, tenant: tenant.id, job });
    return { ...this.followed(ns, jobPath, selector, task), warm: true };
  }

  /**
   * A warm worker: a Job like a task's, its pod's labels and limits the same, that runs the worker with
   * --pool, its ticket in a Secret the Job owns. Its deadline is the most it may wait and a minute, until a
   * task is given to it.
   */
  private async launchWarm(ticket: string): Promise<Started<Slot>> {
    const ns = await this.namespace();
    const id = `pool-${randomBytes(8).toString("hex")}`;
    const name = objectName(id);
    const jobPath = `/apis/batch/v1/namespaces/${ns}/jobs/${name}`;
    const labels = { [POOL_LABEL]: id };
    const env = [{ name: "JIG_POOL_TICKET", valueFrom: { secretKeyRef: { name, key: "ticket" } } }];
    const created = Date.now();
    const job = await this.call<Resource>("POST", `/apis/batch/v1/namespaces/${ns}/jobs`, this.job(name, labels, [...this.worker(), "--pool", this.poolUrl], env, (this.config.pool?.maxIdleSeconds ?? 600) + SLACK_MS / 1000, false));
    await this.secret(ns, name, job, labels, { ticket });
    // The pool hears of a worker that goes from its claim, so this one is gone once its Job is deleted.
    let gone!: () => void;
    const exited = new Promise<void>((done) => (gone = done));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void this.remove(jobPath)
        .catch((err: unknown) => this.log.warn("couldn't delete a warm worker's Job", { job: name, err }))
        .finally(gone);
    };
    return { slot: { job: name, ns, jobPath, created, selector: `${POOL_LABEL}=${id}` }, exited, stop };
  }

  /** Makes the Secret the Job `name` owns, so it is deleted with it; the Job is deleted if it can't be made. */
  private async secret(ns: string, name: string, job: Resource, labels: Record<string, string>, stringData: Record<string, string>): Promise<void> {
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, labels, ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid: job.metadata?.uid }] },
      type: "Opaque",
      stringData,
    };
    await this.call("POST", `/api/v1/namespaces/${ns}/secrets`, secret).catch(async (err: unknown) => {
      await this.remove(`/apis/batch/v1/namespaces/${ns}/jobs/${name}`).catch(() => {});
      throw err;
    });
  }

  /**
   * The run of the Job's pod (the one `selector` finds), followed to its end; a cancel deletes the Job,
   * asked again every few seconds until it is deleted or the run has ended otherwise.
   */
  private followed(ns: string, jobPath: string, selector: string, task: Task): RunHandle {
    const { graceSeconds, pollMs = 1000 } = this.config;
    const events = new Channel<JigEvent>();
    let cancelled = false;
    let finished = false;
    let retry: NodeJS.Timeout | undefined;
    const backstop = Date.now() + (task.spec.timeLimit + graceSeconds) * 1000 + SLACK_MS;
    const exit = this.follow(ns, jobPath, selector, task.id, events, pollMs, backstop).finally(() => {
      finished = true;
      clearTimeout(retry);
      events.close();
    });
    // A DELETE lost to a blip of the API server would leave the run going, and spending, until its deadline.
    const remove = () => {
      this.remove(jobPath).catch((err: unknown) => {
        this.log.warn("couldn't delete the task's Job", { task: task.id, err });
        if (!finished) retry = setTimeout(remove, Math.max(pollMs, 1000) * 2);
      });
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      // The run's last events are still read, however slowly, so follow() can't wait on them past its end.
      events.release();
      remove();
    };
    return { events: events.drain(), wait: () => exit, cancel };
  }

  private worker(): string[] {
    return this.config.worker ?? ["node", "/opt/jig/server/worker.ts"];
  }

  /** jig's command line in the pod, its events to stdout, into the pod's log. */
  private jigCommand(task: Task, tenant: Tenant): string[] {
    const { jig = ["jig"] } = this.config;
    return [...jig, "--no-sandbox", ...jigArgs(task, tenant, { cwd: `${TASK}/work`, events: "-", stats: `${TASK}/stats.json`, baseUrl: this.config.gatewayBaseUrl, internalBaseUrl: this.config.internalBaseUrl })];
  }

  /**
   * A Job: one pod, run once, ended at `deadline` seconds, kept for the ttl, locked down as every task's
   * pod is. `input` mounts the task's input from the Secret named as the Job.
   */
  private job(name: string, labels: Record<string, string>, command: string[], env: object[], deadline: number, input: boolean, annotations?: Record<string, string>): object {
    const { image, user = 10001 } = this.config;
    const all = { ...ROLE_LABELS, ...labels };
    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, labels: all, ...(annotations && { annotations }) },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: deadline,
        ttlSecondsAfterFinished: this.config.ttlSecondsAfterFinished ?? 600,
        template: {
          metadata: { labels: all },
          spec: {
            restartPolicy: "Never",
            ...(this.config.runtimeClassName && { runtimeClassName: this.config.runtimeClassName }),
            serviceAccountName: this.config.serviceAccountName ?? "jig-task",
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 5,
            securityContext: { runAsNonRoot: true, runAsUser: user, runAsGroup: user, fsGroup: user, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "jig",
                image,
                command,
                workingDir: TASK,
                env: [{ name: "HOME", value: `${TASK}/home` }, { name: "JIG_HOME", value: `${TASK}/home/.jig` }, { name: "NO_COLOR", value: "1" }, ...env],
                resources: this.config.resources ?? RESOURCES,
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
                volumeMounts: [
                  ...(input ? [{ name: "input", mountPath: INPUT, readOnly: true }] : []),
                  { name: "task", mountPath: TASK },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              ...(input ? [{ name: "input", secret: { secretName: name, items: [{ key: "task.json", path: "task.json" }] } }] : []),
              { name: "task", emptyDir: {} },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    };
  }

  /**
   * Follows the run to its end: waits for the pod to start, passes on the events in its log (again from
   * the start, the ones already passed left out, should the stream break), then reads how it ended from
   * the pod and the Job. While the pod hasn't started, it looks less and less often, up to every 5 seconds:
   * a cluster may have many tasks waiting for a node.
   */
  private async follow(ns: string, jobPath: string, selector: string, task: string, events: Channel<JigEvent>, pollMs: number, backstop: number): Promise<RunExit> {
    let seq = 0;
    let said: string | undefined;
    let worker: { exitCode?: number; stats?: unknown } = {};
    /** The container has run; its log was read to the end; and the last line read was the worker's (or one like it). */
    let started = false;
    let logged = false;
    let reported = false;
    let pod: Resource | undefined;
    let failure: unknown;
    let pause = pollMs;
    for (;;) {
      try {
        const job = await this.get(jobPath);
        pod = (await this.get(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(selector)}`))?.items?.[0] ?? pod;
        const container = pod?.status?.containerStatuses?.[0]?.state;
        if (!job) return { exitCode: container?.terminated?.exitCode ?? worker.exitCode ?? null, timedOut: false, stats: worker.stats, message: "its Job was deleted" };
        if (!logged && (container?.running || container?.terminated)) {
          started = true;
          const res = await this.send("GET", `/api/v1/namespaces/${ns}/pods/${pod!.metadata!.name}/log?container=jig&follow=true`, undefined, 0);
          // A stream that stays open with nothing on it is let go at the backstop.
          const hang = setTimeout(() => res.destroy(), Math.max(0, backstop - Date.now()));
          if (res.statusCode === 200) {
            for await (const line of lines(res)) {
              const event = parseEvent(line);
              // The worker writes its line last: a stream that ends with it has the whole log. A task's commands
              // can write such a line too, which at worst ends the read of their own task's log early.
              reported = false;
              if (event && event.seq > seq) {
                // jig's seqs follow one another: a gap is events the log no longer has, once the kubelet has
                // rotated it before a read again (or ones too long to read). A notice takes the first's seq.
                if (event.seq > seq + 1) {
                  const text = `Events ${seq + 1} to ${event.seq - 1} aren't in the pod's log: it was rotated before it was read again, or they were too long to read.`;
                  this.log.warn(text, { task });
                  await events.push({ v: 1, seq: seq + 1, ts: event.ts, type: "notice", text });
                }
                seq = event.seq;
                // Waits while the reader is behind, which leaves the rest of the log on the API server.
                await events.push(event);
              } else if (!event) {
                const ours = workerLine(line);
                if (ours) [worker, reported] = [ours, true];
                else if (line.trim()) said = line.trim().slice(-500);
              }
            }
          } else res.resume();
          clearTimeout(hang);
          // Read to its end once the container has ended, or once the stream ended with the worker's line (the
          // kubelet ends it as the container exits, a moment before the pod's status says so); a stream cut
          // short before is read again.
          const after = await this.get(`/api/v1/namespaces/${ns}/pods/${pod!.metadata!.name}`);
          if (after) pod = after;
          logged = !after || reported || Boolean(after.status?.containerStatuses?.[0]?.state?.terminated);
          if (logged) continue;
        }
        const ended = job.status?.conditions?.find((condition) => ["Complete", "Failed"].includes(condition.type) && condition.status === "True");
        if (ended && (logged || !started)) {
          const terminated = pod?.status?.containerStatuses?.[0]?.state?.terminated;
          const exitCode = terminated?.exitCode ?? worker.exitCode ?? null;
          // A pod that never started (its image couldn't be pulled, say) is an error, not a time limit.
          const timedOut = started && ended.reason === "DeadlineExceeded";
          // Why it never started: its container's waiting reason, or, with no container yet, the scheduler's.
          const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting ?? pod?.status?.conditions?.find((condition) => condition.type === "PodScheduled" && condition.status === "False");
          const message =
            terminated?.reason === "OOMKilled" ? `it ran out of memory (OOMKilled)${said ? `: ${said}` : ""}`
            : exitCode === null ? [ended.reason, ended.message, waiting && `the pod was ${waiting.reason}: ${waiting.message ?? ""}`].filter(Boolean).join(": ")
            : exitCode === 0 ? undefined : said;
          return { exitCode, timedOut, stats: worker.stats, message: message || undefined };
        }
        failure = undefined;
      } catch (err) {
        // The API server may be back in a moment: the backstop decides when to stop asking.
        failure = err;
      }
      if (Date.now() > backstop) {
        await this.remove(jobPath).catch(() => {});
        return { exitCode: null, timedOut: !failure, stats: worker.stats, message: failure ? `the Kubernetes API failed: ${failure instanceof Error ? failure.message : String(failure)}` : undefined };
      }
      await new Promise((done) => setTimeout(done, started ? pollMs : pause));
      if (!started) pause = Math.min(pause * 2, Math.max(pollMs, PENDING_POLL_MS));
    }
  }

  /** Deletes the Job, and with it (in the background) its pod and Secret. */
  private async remove(jobPath: string): Promise<void> {
    await this.call("DELETE", `${jobPath}?propagationPolicy=Background`, { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background" }, [404]);
  }

  private namespace(): Promise<string> {
    this.ns ??= this.config.namespace !== undefined ? Promise.resolve(this.config.namespace) : readFile(`${ACCOUNT}/namespace`, "utf8").then((text) => text.trim());
    return this.ns;
  }

  /** An object, or undefined where there is none (404). */
  private async get(path: string): Promise<Resource | undefined> {
    return this.call<Resource | undefined>("GET", path, undefined, [404]);
  }

  /** A request's answer as JSON; undefined for the statuses in `missing`, an error for any other but 2xx. */
  private async call<T>(method: string, path: string, body?: object, missing: number[] = [], type = "application/json"): Promise<T> {
    const res = await this.send(method, path, body, 30_000, type);
    let text = "";
    for await (const chunk of res) text += chunk;
    const status = res.statusCode ?? 0;
    if (missing.includes(status)) return undefined as T;
    let answer: Resource | undefined;
    try {
      answer = JSON.parse(text);
    } catch {}
    if (status < 200 || status > 299) throw new Error(`${method} ${path.split("?")[0]}: ${status} ${answer?.message ?? text.slice(0, 200)}`);
    return answer as T;
  }

  /** A request's response; one that takes over `timeoutMs` to answer, or is idle that long, fails. */
  private async send(method: string, path: string, body?: object, timeoutMs = 30_000, type = "application/json"): Promise<IncomingMessage> {
    const url = new URL(`${(this.config.apiUrl ?? "https://kubernetes.default.svc").replace(/\/$/, "")}${path}`);
    const token = (await readFile(this.config.tokenFile ?? `${ACCOUNT}/token`, "utf8")).trim();
    const https = url.protocol === "https:";
    if (https) this.ca ??= readFile(this.config.caFile ?? `${ACCOUNT}/ca.crt`);
    const ca = https ? await this.ca : undefined;
    const data = body && JSON.stringify(body);
    return new Promise((done, fail) => {
      // A length, as Node sends a DELETE's body without one otherwise, which the server can't tell from the next request.
      const headers = { authorization: `Bearer ${token}`, accept: "application/json", ...(data && { "content-type": type, "content-length": Buffer.byteLength(data) }) };
      const req = (https ? httpsRequest : httpRequest)(url, { method, headers, ca }, done);
      req.on("error", fail);
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs / 1000} seconds`)));
      req.end(data);
    });
  }
}

/** A task's labels: its id, and its tenant's as a label value. */
function taskLabels(task: Task, tenant: Tenant): Record<string, string> {
  return { [TASK_LABEL]: task.id, "jig.dev/tenant": labelValue(tenant.id) };
}

/** The tenant's id as it is, in an annotation, which takes any value. */
function tenantAnnotation(tenant: Tenant): Record<string, string> {
  return { "jig.dev/tenant": tenant.id };
}

/**
 * An id as a label's value: as it is where Kubernetes takes it (63 characters at most, letters, digits, -, _
 * and ., starting and ending with a letter or digit), otherwise h- and 40 hex digits of its SHA-256.
 */
export function labelValue(id: string): string {
  if (id.length <= 63 && /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(id)) return id;
  return `h-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

/** A task's Job's (and Secret's) name: Kubernetes takes lowercase letters, digits and dashes, not task ids' _. */
export function objectName(id: string): string {
  return `jig-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 63).replace(/-+$/, "");
}

/** The worker's own line after jig's events, if the line is one. */
function workerLine(line: string): { exitCode?: number; stats?: unknown } | undefined {
  try {
    const value = JSON.parse(line);
    return value?.jigWorker === 1 ? { exitCode: Number.isInteger(value.exitCode) ? value.exitCode : undefined, stats: value.stats } : undefined;
  } catch {
    return undefined;
  }
}

/** A response's lines, the last one too if it has no newline; one over MAX_LINE is left out. */
async function* lines(res: IncomingMessage): AsyncGenerator<string> {
  // The task's commands can write the log too (through /proc/1/fd/1), so no line is held whole.
  const split = new Lines();
  for await (const chunk of res as AsyncIterable<Buffer>) yield* split.push(chunk);
  const last = split.end();
  if (last) yield last;
}

/**
 * A queue one side pushes to and the other drains, as an async iterable, until it is closed. A push into a
 * queue holding `limit` items gives a promise that settles once the reader has taken one, so a task's
 * commands that flood the pod's log can't fill the service's memory. The pusher is never left waiting on a
 * reader that has gone: once the reader stops, what comes is dropped; and release(), at a cancel, lifts the
 * limit, so a run that is being stopped is read to its end whether or not anyone still reads its events.
 */
export class Channel<T> {
  private items: T[] = [];
  private closed = false;
  private bounded = true;
  private dropping = false;
  private wake: (() => void) | undefined;
  private room: (() => void) | undefined;
  private limit: number;

  constructor(limit = 1000) {
    this.limit = limit;
  }

  get length(): number {
    return this.items.length;
  }

  push(item: T): Promise<void> | undefined {
    if (this.dropping) return undefined;
    this.items.push(item);
    this.wake?.();
    if (!this.bounded || this.items.length < this.limit) return undefined;
    return new Promise<void>((done) => (this.room = done));
  }

  /** Takes the limit off: the pusher no longer waits. */
  release(): void {
    this.bounded = false;
    this.free();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<T> {
    try {
      for (;;) {
        while (this.items.length) {
          const item = this.items.shift()!;
          if (this.items.length < this.limit) this.free();
          yield item;
        }
        if (this.closed) return;
        await new Promise<void>((done) => (this.wake = done));
        this.wake = undefined;
      }
    } finally {
      // The reader is done, ended or not: what's left, and anything pushed after, is dropped.
      this.items = [];
      this.dropping = true;
      this.release();
    }
  }

  private free(): void {
    const room = this.room;
    this.room = undefined;
    room?.();
  }
}
