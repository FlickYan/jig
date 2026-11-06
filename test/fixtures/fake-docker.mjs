// A stand-in for the docker CLI in the runners' tests (test/server-runners.test.ts), run as
// `fake-docker.mjs <state folder> <docker's arguments>`. `run` records its arguments and environment in
// <state>/<name>.json and runs the container's command as the fake jig, with the paths under the bind
// mount's target read as its source, in a process group of its own. `kill --signal <s> <name>` records
// the kill in <state>/kills.jsonl and sends the signal to that group. `rename <old> <new>` records the
// rename in <state>/renames.jsonl and moves <old>.pid to <new>.pid, so kills find the container by its new
// name only (its run's record keeps the name it ran with). A flag it doesn't know fails as
// docker's do, with 125. Files in <state> change what it does: `delay` holds the milliseconds `run` takes
// before the container exists (its image being pulled), a `deaf` container ignores TERM, as a jig whose
// commands hold it up might, and `flood` holds the length of an event too long to read (a text of that
// many x's) that the container's commands write in the events file before jig starts.
//
// A warm worker's container (its command has --pool <url>) runs the real server/worker.ts, its claim passed
// through a proxy here that turns the container's paths in the answer into the host's, and jig into the
// fake jig, as `run` does for a task's own command.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { constants } from "node:os";
import { join } from "node:path";

const [state, command, ...rest] = process.argv.slice(2);
const FAKE_JIG = join(import.meta.dirname, "fake-jig.mjs");
const WORKER = join(import.meta.dirname, "..", "..", "server", "worker.ts");
const VALUED = new Set(["--name", "--label", "--user", "--cpus", "--memory", "--memory-swap", "--pids-limit", "--tmpfs", "--mount", "--workdir", "--cap-drop", "--cap-add", "--security-opt", "--runtime", "--network", "--env"]);
const FLAGS = new Set(["--rm", "--interactive", "--init", "--read-only", "--privileged"]);

if (command === "run") {
  const options = [];
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("-"); i++) {
    if (FLAGS.has(rest[i])) options.push([rest[i]]);
    else if (VALUED.has(rest[i])) options.push([rest[i], rest[++i]]);
    else {
      console.error(`unknown flag: ${rest[i]}`);
      process.exit(125);
    }
  }
  const [image, program, ...args] = rest.slice(i);
  const values = (flag) => options.filter(([name]) => name === flag).map(([, value]) => value);
  const name = values("--name")[0];
  writeFileSync(join(state, `${name}.json`), JSON.stringify({ args: rest, env: process.env, image, program }));
  const mount = Object.fromEntries(values("--mount")[0].split(",").map((part) => part.split("=")));
  const host = (path) => (path === mount.target || path.startsWith(`${mount.target}/`) ? mount.source + path.slice(mount.target.length) : path);
  const option = (file) => (existsSync(join(state, file)) ? Number(readFileSync(join(state, file), "utf8")) : 0);
  await new Promise((done) => setTimeout(done, option("delay")));
  const flood = option("flood");
  if (flood) appendFileSync(host("/task/events.jsonl"), `${JSON.stringify({ v: 1, seq: 2, ts: "", type: "text", text: "x".repeat(flood) })}\n`);
  const env = { PATH: process.env.PATH };
  for (const entry of values("--env")) {
    const [key, ...value] = entry.split("=");
    // A path in the container (HOME=/task/home) is the mount's on the host, as for the arguments.
    env[key] = value.length ? host(value.join("=")) : process.env[key];
  }
  let argv = [FAKE_JIG, ...args.map(host)];
  if (args.includes("--pool")) {
    const upstream = args[args.indexOf("--pool") + 1];
    const proxy = createServer(async (req, res) => {
      const answer = await fetch(upstream + req.url, { method: req.method, headers: { authorization: req.headers.authorization ?? "" } }).catch(() => undefined);
      if (!answer) return res.destroy();
      if (answer.status !== 200) return res.writeHead(answer.status).end(await answer.text());
      const task = await answer.json();
      const [, ...jigArgs] = task.command;
      Object.assign(task, { work: host(task.work), stats: host(task.stats), command: [process.execPath, FAKE_JIG, ...jigArgs.map(host)] });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(task));
    });
    await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
    argv = [WORKER, "--pool", `http://127.0.0.1:${proxy.address().port}`];
  }
  const child = spawn(process.execPath, argv, { cwd: host(values("--workdir")[0]), env, detached: true, stdio: "inherit" });
  writeFileSync(join(state, `${name}.pid`), String(child.pid));
  child.on("exit", (code, signal) => process.exit(code ?? 128 + constants.signals[signal]));
} else if (command === "kill") {
  const signal = rest[rest.indexOf("--signal") + 1];
  const name = rest.at(-1);
  appendFileSync(join(state, "kills.jsonl"), `${JSON.stringify({ signal, name })}\n`);
  let pid;
  try {
    pid = Number(readFileSync(join(state, `${name}.pid`), "utf8"));
  } catch {
    console.error(`Error response from daemon: No such container: ${name}`);
    process.exit(1);
  }
  if (signal === "TERM" && existsSync(join(state, "deaf"))) process.exit(0);
  try {
    process.kill(-pid, `SIG${signal}`);
  } catch {} // already gone
} else if (command === "rename") {
  const [from, to] = rest;
  appendFileSync(join(state, "renames.jsonl"), `${JSON.stringify({ from, to })}\n`);
  if (!existsSync(join(state, `${from}.pid`))) {
    console.error(`Error response from daemon: No such container: ${from}`);
    process.exit(1);
  }
  if (existsSync(join(state, `${to}.pid`))) {
    console.error(`Error response from daemon: Conflict. The container name "/${to}" is already in use`);
    process.exit(1);
  }
  renameSync(join(state, `${from}.pid`), join(state, `${to}.pid`));
} else {
  console.error(`fake docker: no command ${command}`);
  process.exit(1);
}
