import { whyStopped } from "./tools/bash.ts";
import * as ui from "./ui.ts";

// jig proposes, the user approves: anything jig would change about itself (a memory, AGENTS.md) is put to
// the user first. Tools that propose have the kind "propose": they run one at a time, so their questions
// don't overlap, in any permission mode, since nothing changes until the user says yes.

/**
 * Puts a proposal to the user: a title, then what would change. True means go ahead. The task's signal
 * stopping (at --time-limit) closes the question unanswered, so it doesn't wait past the limit.
 */
export type Approve = (title: string, details: string, signal?: AbortSignal) => Promise<boolean>;

/**
 * Asks in the terminal. With `yes` (as `jig memory reflect --yes`), every proposal is accepted and said
 * so; with no terminal and no `yes`, none is.
 */
export function terminalApprover({ yes = false }: { yes?: boolean } = {}): Approve {
  return async (title, details, signal) => {
    if (yes) {
      ui.notice(`${title} (kept: --yes)`);
      return true;
    }
    if (!process.stdin.isTTY) return false;
    ui.println();
    ui.println(ui.bold(title));
    ui.println(details);
    const answer = await ui.ask("Keep it? [y]es / [n]o: ", signal);
    return answer?.trim().toLowerCase().startsWith("y") ?? false;
  };
}

/** What a tool tells the model when nobody approved, or the task stopped while it was asking. */
export function notApproved(what: string, signal?: AbortSignal): string {
  if (signal?.aborted) return `Nothing was saved: ${whyStopped(signal, "the user stopped the task")}.`;
  return process.stdin.isTTY
    ? `The user didn't approve the ${what}. If it isn't clear why, ask them what to change.`
    : `Nobody could approve the ${what} (there is no terminal), so nothing was saved. In a terminal, \`jig memory reflect\` proposes it again.`;
}
