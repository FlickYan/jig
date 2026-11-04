// A stand-in for jig in the task service's tests (test/server-*.test.ts). It takes jig's arguments, reads
// its task from stdin, writes events in the shape of the event contract to --events (- for stdout), and
// does what the task says: "exit <n>" ends with that exit code, "wait" waits for a file named go in its
// project before it ends, and "hang" starts a child process and never ends. With --approve-via, "ask <n>"
// asks for n approvals before a command, as the approval contract has jig do: an approval_request event,
// a long poll of <url>/<id> with its API key, then an approval event. It records its arguments,
// environment, process ids and the polls' statuses in .fake-jig.json in its project.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    events: { type: "string" },
    stats: { type: "string" },
    cwd: { type: "string", short: "C" },
    model: { type: "string" },
    "max-steps": { type: "string" },
    "time-limit": { type: "string" },
    mode: { type: "string" },
    "approve-via": { type: "string" },
    "approval-timeout": { type: "string" },
  },
});
let task = "";
for await (const chunk of process.stdin) task += chunk;

const STOPS = { 0: "end_turn", 1: "error", 2: "max_steps", 3: "max_tokens", 4: "refusal", 5: "unapproved", 6: "loop", 7: "time_limit", 8: "empty" };
const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 };
let seq = 0;
const emit = (type, fields) => {
  const line = `${JSON.stringify({ v: 1, seq: ++seq, ts: new Date().toISOString(), type, ...fields })}\n`;
  if (values.events === "-") process.stdout.write(line);
  else appendFileSync(values.events, line);
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const record = { args: process.argv.slice(2), env: process.env, task, pid: process.pid, polls: [] };
const save = () => writeFileSync(join(values.cwd, ".fake-jig.json"), JSON.stringify(record));

emit("start", { task, cwd: values.cwd, model: values.model, version: "0.1.0", limits: { maxSteps: Number(values["max-steps"]), timeLimit: Number(values["time-limit"]) } });
await pause(20);
emit("tool_call", { step: 1, id: "call_1", name: "bash", description: "ls" });
await pause(20);
emit("tool_result", { step: 1, id: "call_1", isError: false, output: "README.md\n" });
emit("step", { step: 1, usage, cost: 0.001 });

/** The answer to approval `id`: polled for until it comes, or a deny at the timeout. */
async function answerTo(id) {
  const deadline = Date.now() + Number(values["approval-timeout"] ?? 600) * 1000;
  const key = process.env.ANTHROPIC_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  for (let backoff = 1000; Date.now() < deadline; ) {
    try {
      const res = await fetch(`${values["approve-via"]}/${id}?wait=25`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(deadline - Date.now()) });
      record.polls.push(res.status);
      if (res.status === 200) return { ...(await res.json()), by: "api" };
      await res.body?.cancel();
      if (res.status === 204) continue;
    } catch {
      record.polls.push("error");
    }
    await pause(Math.min(backoff, Math.max(0, deadline - Date.now())));
    backoff = Math.min(backoff * 2, 10_000);
  }
  return { decision: "deny", always: false, by: "timeout" };
}

const asks = values["approve-via"] ? Number(/ask (\d+)/.exec(task)?.[1] ?? 0) : 0;
for (let n = 1; n <= asks; n++) {
  const id = `ap_${n}`;
  emit("approval_request", { step: 2, id, tool: "bash", description: `rm -rf build/${n}` });
  const { decision, always = false, by } = await answerTo(id);
  emit("approval", { id, decision, always, by });
  emit("tool_call", { step: 2, id: `call_${n + 1}`, name: "bash", description: `rm -rf build/${n}` });
  emit("tool_result", { step: 2, id: `call_${n + 1}`, isError: decision !== "allow", output: decision === "allow" ? "" : "The user declined this command." });
}

if (task.includes("hang")) {
  // In jig's process group: only a kill of the whole group ends it.
  record.child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;
  save();
  setInterval(() => {}, 1000);
} else {
  save();
  while (task.includes("wait") && !existsSync(join(values.cwd, "go"))) await pause(20);
  const code = Number(/exit (\d+)/.exec(task)?.[1] ?? 0);
  emit("text", { step: 2, text: "Done." });
  emit("step", { step: 2, usage, cost: 0.001 });
  emit("end", { stop: STOPS[code] ?? "error", exitCode: code, steps: 2, usage: { input: 20, cacheRead: 0, cacheWrite: 0, output: 10 }, cost: 0.002, seconds: 0.1 });
  writeFileSync(values.stats, JSON.stringify({ stop: STOPS[code] ?? "error", steps: 2 }));
  if (code) console.error(`fake jig: stopped with ${code}`);
  process.exitCode = code;
}
