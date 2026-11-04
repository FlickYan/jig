// What belongs to one run of jig rather than to the process it runs in: jig's directory, the environment
// its commands get, and who hears what it tells the user. The CLI runs one task or session a process and
// leaves these to the process. A program that runs jig as a library (lib.ts) can run several tasks at once
// in one process, each with its own: every function called on a task's behalf, however deep, finds the
// task's here, as Node's AsyncLocalStorage follows the promises, timers and callbacks the task starts.

import { AsyncLocalStorage } from "node:async_hooks";

export interface Context {
  /** jig's directory, for $JIG_HOME (or ~/.jig). */
  home?: string;
  /** The environment its commands, hooks and git get (without the API keys), for the process's. */
  env?: NodeJS.ProcessEnv;
  /** Prints nothing: a library's task has no terminal, and the process's stdout and stderr aren't its own. */
  silent?: boolean;
  /** Hears each notice and error jig tells the user (but a subagent's, which are its own): --events'. */
  told?: (text: string) => void;
}

const store = new AsyncLocalStorage<Context>();
/** The process's own, outside any run: the same object each time, so what is kept per run works there too. */
const outside: Context = {};

/** Runs `work` with `context` as its own, and what it starts, however long that runs. */
export function withContext<T>(context: Context, work: () => T): T {
  return store.run(context, work);
}

/** The context of the run this is called for; outside one, nothing, so the process's own holds. */
export function context(): Context {
  return store.getStore() ?? outside;
}
