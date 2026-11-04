// A stand-in for the docker CLI in the runners' tests (test/server-runners.test.ts), run as
// `fake-docker.mjs <state folder> <docker's arguments>`. `run` records its arguments and environment in
// <state>/<name>.json and runs the container's command as the fake jig, with the paths under the bind
// mount's target read as its source, in a process group of its own. `kill --signal <s> <name>` records
// the kill in <state>/kills.jsonl and sends the signal to that group. A flag it doesn't know fails as
// docker's do, with 125. Files in <state> change what it does: `delay` holds the milliseconds `run` takes
// before the container exists (its image being pulled), a `deaf` container ignores TERM, as a jig whose
// commands hold it up might, and `flood` holds the length of an event too long to read (a text of that
// many x's) that the container's commands write in the events file before jig starts.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const [state, command, ...rest] = process.argv.slice(2);
const FAKE_JIG = join(import.meta.dirname, "fake-jig.mjs");
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
    env[key] = value.length ? value.join("=") : process.env[key];
  }
  const child = spawn(process.execPath, [FAKE_JIG, ...args.map(host)], { cwd: host(values("--workdir")[0]), env, detached: true, stdio: "inherit" });
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
} else {
  console.error(`fake docker: no command ${command}`);
  process.exit(1);
}
