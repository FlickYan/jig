// --approve-via: the tool calls jig would ask about at a terminal, asked of a service over HTTP instead, for
// a task no one runs at a terminal (the task service's, with approvals on). jig writes an approval_request
// event, which the service shows its tenant, and polls the service for the answer a person gives through
// its API: GET <url>/<id>?wait=25 with the API key jig uses as the Bearer (in the service, the task's
// gateway token), which the service holds up to that many seconds. 200 with {decision, always} is the
// answer; 204 is none yet, asked again at once; anything else, or a connection that fails, is asked again
// after 1, 2, 4 ... seconds, 10 at most, so a service that is down or restarting isn't flooded. With no
// answer by --approval-timeout the call is denied. The task stopping (its signal, at --time-limit too)
// stops the wait. run.ts answers the call as the terminal would, as for a library's approver.

import { setTimeout as sleep } from "node:timers/promises";
import type { Approval, ApprovalRequest } from "./run.ts";

/** The longest the service is asked to hold a poll: under the 30 it holds one at most. */
const WAIT_SECONDS = 25;
const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 10_000;

/** An answer, and who gave it: the service, or the timeout, where none came in time. */
export type Answer = Approval & { by?: "api" | "timeout" };

/** Asks `url` about each call, as `Bearer key`, until it answers or `timeout` seconds have passed. */
export function httpApprover(url: string, key: string, timeout: number) {
  const base = url.replace(/\/+$/, "");
  return async ({ id }: ApprovalRequest, signal: AbortSignal): Promise<Answer> => {
    // In whole milliseconds: AbortSignal.timeout throws on a fraction of one, as 1.0001 seconds would give.
    const waiting = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(timeout * 1000))]);
    let retry = FIRST_RETRY_MS;
    while (!waiting.aborted) {
      try {
        const response = await fetch(`${base}/${encodeURIComponent(id)}?wait=${WAIT_SECONDS}`, { headers: { authorization: `Bearer ${key}` }, signal: waiting });
        if (response.status === 204) {
          await response.body?.cancel();
          retry = FIRST_RETRY_MS;
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
        } else {
          const answer = decision(await response.json());
          if (answer) return { ...answer, by: "api" };
        }
      } catch {
        // A connection that failed, or a body that isn't JSON: tried again like an error status.
      }
      await sleep(retry, undefined, { signal: waiting }).catch(() => {});
      retry = Math.min(retry * 2, LAST_RETRY_MS);
    }
    // Stopped by the task, whose end run.ts reports, or by the timeout: the call is denied.
    return { decision: "deny", by: "timeout" };
  };
}

/** The answer in a 200's body, or undefined if it holds none. */
function decision(body: unknown): Approval | undefined {
  const { decision, always } = (body ?? {}) as Record<string, unknown>;
  if (decision !== "allow" && decision !== "deny") return undefined;
  return { decision, always: always === true };
}
