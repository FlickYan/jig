import { readFile } from "node:fs/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { StringDecoder } from "node:string_decoder";
import { type JigEvent, jigArgs, keyVariable, type RunExit, type RunHandle, type Runner, taskToken } from "../runner.ts";
import type { Task, Tenant } from "../store.ts";
import type { WorkerInput } from "../worker.ts";
import { parseEvent } from "./local.ts";

// Runs each task as a Kubernetes Job of its own, through the API server with the service account's
// token. The Job's one pod runs server/worker.ts in the worker image, which makes the workspace and starts
// jig with `--events -`, so the events come in the pod's log, which this follows: a pod's files are on its
// node, out of the service's reach, while its log is the API server's to give. The prompt, the workspace
// and the task's gateway token go in a Secret the Job owns, so they are deleted with it.

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
  /** How often the Job and its pod are looked at, in milliseconds (default: 1000). */
  pollMs?: number;
}

const ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";
const RESOURCES = { requests: { cpu: "250m", memory: "1Gi", "ephemeral-storage": "1Gi" }, limits: { cpu: "1", memory: "2Gi", "ephemeral-storage": "4Gi" } };
/** The label the runner finds a task's pod by, and the one the deploy files' NetworkPolicy selects. */
export const TASK_LABEL = "jig.dev/task";
export const ROLE_LABELS = { "app.kubernetes.io/name": "jig", "app.kubernetes.io/component": "task" };
// Where the pod keeps the task's input and folder, and how long it waits for the API server past the
// deadline the Job itself keeps, should the Job controller not stop it.
const INPUT = "/task-input";
const TASK = "/task";
const SLACK_MS = 60_000;

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
  private config: KubernetesRunnerConfig;
  private ca: Promise<Buffer> | undefined;
  private ns: Promise<string> | undefined;

  constructor(config: KubernetesRunnerConfig) {
    this.config = config;
  }

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    const { graceSeconds, pollMs = 1000 } = this.config;
    const ns = await this.namespace();
    const name = objectName(task.id);
    const jobPath = `/apis/batch/v1/namespaces/${ns}/jobs/${name}`;
    const job = await this.call<Resource>("POST", `/apis/batch/v1/namespaces/${ns}/jobs`, this.job(task, tenant, name));
    const input: WorkerInput = { prompt: task.spec.prompt, workspace: task.spec.workspace, gitProtocols: this.config.gitProtocols ?? ["https"], work: `${TASK}/work`, stats: `${TASK}/stats.json` };
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, labels: { [TASK_LABEL]: task.id }, ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid: job.metadata?.uid }] },
      type: "Opaque",
      stringData: { token: taskToken(this.config.gatewaySecret, task, tenant, graceSeconds), "task.json": JSON.stringify(input) },
    };
    // Made after the Job, whose uid it needs to be deleted with it; the pod waits for it to mount.
    await this.call("POST", `/api/v1/namespaces/${ns}/secrets`, secret).catch(async (err: unknown) => {
      await this.remove(jobPath).catch(() => {});
      throw err;
    });

    const events = new Channel<JigEvent>();
    let cancelled = false;
    const backstop = Date.now() + (task.spec.timeLimit + graceSeconds) * 1000 + SLACK_MS;
    const exit = this.follow(ns, jobPath, task.id, events, pollMs, backstop).finally(() => events.close());
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      this.remove(jobPath).catch((err: unknown) => console.error(`jig service: couldn't delete the Job of ${task.id}:`, err));
    };
    return { events: events.drain(), wait: () => exit, cancel };
  }

  /** The Job for a task: one pod, run once, ended at the time limit and the grace, kept for the ttl. */
  private job(task: Task, tenant: Tenant, name: string): object {
    const { image, worker = ["node", "/opt/jig/server/worker.ts"], jig = ["jig"], user = 10001 } = this.config;
    const labels = { ...ROLE_LABELS, [TASK_LABEL]: task.id, "jig.dev/tenant": tenant.id };
    const command = [...worker, `${INPUT}/task.json`, ...jig, "--no-sandbox", ...jigArgs(task, { cwd: `${TASK}/work`, events: "-", stats: `${TASK}/stats.json`, baseUrl: this.config.gatewayBaseUrl })];
    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, labels },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: task.spec.timeLimit + this.config.graceSeconds,
        ttlSecondsAfterFinished: this.config.ttlSecondsAfterFinished ?? 600,
        template: {
          metadata: { labels },
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
                env: [
                  { name: "HOME", value: `${TASK}/home` },
                  { name: "JIG_HOME", value: `${TASK}/home/.jig` },
                  { name: "NO_COLOR", value: "1" },
                  { name: keyVariable(task.spec.model), valueFrom: { secretKeyRef: { name, key: "token" } } },
                ],
                resources: this.config.resources ?? RESOURCES,
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
                volumeMounts: [
                  { name: "input", mountPath: INPUT, readOnly: true },
                  { name: "task", mountPath: TASK },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "input", secret: { secretName: name, items: [{ key: "task.json", path: "task.json" }] } },
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
   * the pod and the Job.
   */
  private async follow(ns: string, jobPath: string, id: string, events: Channel<JigEvent>, pollMs: number, backstop: number): Promise<RunExit> {
    let seq = 0;
    let said: string | undefined;
    let worker: { exitCode?: number; stats?: unknown } = {};
    /** The container has run; and its log was read to the end. */
    let started = false;
    let logged = false;
    let pod: Resource | undefined;
    let failure: unknown;
    for (;;) {
      try {
        const job = await this.get(jobPath);
        pod = (await this.get(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`${TASK_LABEL}=${id}`)}`))?.items?.[0] ?? pod;
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
              if (event && event.seq > seq) {
                seq = event.seq;
                events.push(event);
              } else if (!event) {
                const ours = workerLine(line);
                if (ours) worker = ours;
                else if (line.trim()) said = line.trim().slice(-500);
              }
            }
          } else res.resume();
          clearTimeout(hang);
          // Read to its end once the container has ended; a stream cut short before is read again.
          const after = await this.get(`/api/v1/namespaces/${ns}/pods/${pod!.metadata!.name}`);
          if (after) pod = after;
          logged = !after || Boolean(after.status?.containerStatuses?.[0]?.state?.terminated);
          if (logged) continue;
        }
        const ended = job.status?.conditions?.find((condition) => ["Complete", "Failed"].includes(condition.type) && condition.status === "True");
        if (ended && (logged || !started)) {
          const terminated = pod?.status?.containerStatuses?.[0]?.state?.terminated;
          const exitCode = terminated?.exitCode ?? worker.exitCode ?? null;
          // A pod that never started (its image couldn't be pulled, say) is an error, not a time limit.
          const timedOut = started && ended.reason === "DeadlineExceeded";
          const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting;
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
      await new Promise((done) => setTimeout(done, pollMs));
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
  private async call<T>(method: string, path: string, body?: object, missing: number[] = []): Promise<T> {
    const res = await this.send(method, path, body);
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
  private async send(method: string, path: string, body?: object, timeoutMs = 30_000): Promise<IncomingMessage> {
    const url = new URL(`${(this.config.apiUrl ?? "https://kubernetes.default.svc").replace(/\/$/, "")}${path}`);
    const token = (await readFile(this.config.tokenFile ?? `${ACCOUNT}/token`, "utf8")).trim();
    const https = url.protocol === "https:";
    if (https) this.ca ??= readFile(this.config.caFile ?? `${ACCOUNT}/ca.crt`);
    const ca = https ? await this.ca : undefined;
    const data = body && JSON.stringify(body);
    return new Promise((done, fail) => {
      // A length, as Node sends a DELETE's body without one otherwise, which the server can't tell from the next request.
      const headers = { authorization: `Bearer ${token}`, accept: "application/json", ...(data && { "content-type": "application/json", "content-length": Buffer.byteLength(data) }) };
      const req = (https ? httpsRequest : httpRequest)(url, { method, headers, ca }, done);
      req.on("error", fail);
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs / 1000} seconds`)));
      req.end(data);
    });
  }
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

/** A response's lines, the last one too if it has no newline. */
async function* lines(res: IncomingMessage): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  for await (const chunk of res as AsyncIterable<Buffer>) {
    partial += decoder.write(chunk);
    const all = partial.split("\n");
    partial = all.pop()!;
    yield* all;
  }
  partial += decoder.end();
  if (partial) yield partial;
}

/** A queue one side pushes to and the other drains, as an async iterable, until it is closed. */
class Channel<T> {
  private items: T[] = [];
  private closed = false;
  private wake: (() => void) | undefined;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((done) => (this.wake = done));
      this.wake = undefined;
    }
  }
}
