# jig

A minimal coding agent for the terminal, written from scratch in TypeScript on the Anthropic Messages API
(Claude, or DeepSeek through its Anthropic-compatible endpoint), and on any OpenAI-compatible API (OpenAI,
DeepSeek's, or a local model through Ollama or vLLM). There is no agent framework: it is one streaming
tool-use loop, six tools, context management (AGENTS.md, saved sessions, compaction), safety (an OS sandbox
on macOS and Linux, permission modes, deny rules, snapshots with undo), extensions (Agent Skills, MCP
servers, hooks, subagents), a benchmark that measures each version, and a loop in which jig proposes
changes to its own code and a referee it can't reach measures them.

(A jig is the workshop fixture that holds a piece of work and guides the tool cutting it, which is what an
agent harness does for a model.)

## Highlights

- **Built from scratch.** No agent framework: one streaming tool-use loop, six tools and subagents, on the
  Anthropic Messages API (Claude, and DeepSeek through its compatible endpoint) and any OpenAI-compatible
  API (OpenAI, DeepSeek's, a local model through Ollama or vLLM). 878 tests, and CI on Linux and macOS.
- **Safe by construction.** Commands run in the operating system's sandbox (Seatbelt on macOS, bubblewrap
  on Linux); permission modes, deny rules, project trust, and snapshots with `/undo`. The API key never
  reaches the commands the model runs, and on Terminal-Bench it stays on the host for DeepSeek and Claude.
- **Context and extensions.** AGENTS.md, saved sessions, compaction; memories, skills and AGENTS.md edits
  that jig proposes and you approve; Agent Skills it installs, writes and measures; MCP servers; hooks.
- **Measured, including what didn't work.** An in-house benchmark with hidden tests, and Terminal-Bench 2.0
  against mini-swe-agent on the same model, with 95% intervals and attempts that look up the answers
  counted as failures. Most ideas tried here didn't beat the noise, and the write-ups say so.
- **It changes itself, under a referee it can't reach.** jig diagnoses its own failures, proposes changes
  to its own code in a copy without the benchmarks, and a referee whose false acceptances were measured
  first judges them on training tasks, then held-out ones, then Terminal-Bench.
- **On a real issue, filed after its model.** [Python-Markdown #1651](examples/python-markdown-1651), filed
  after jig's default model was in use, with the maintainers' tests hidden: in three attempts jig traced
  the lost text through Python-Markdown's parser into the standard library's, fixed it the way the
  maintainers did (the same output on 49,396 generated inputs) and passed their tests, for $0.13 in all.

## Quick start

You need Node 22.18 or newer and an API key: DeepSeek for the default model (`deepseek-flash`),
Anthropic for Claude models, or whatever an OpenAI-compatible API asks for.

```bash
export DEEPSEEK_API_KEY=sk-...    # or ANTHROPIC_API_KEY, and pass --model claude-opus-5-5

npx jig-agent "the login test is failing, fix it"   # run one task in the current directory
npm install -g jig-agent                            # or install it: then `jig` in any project
```

Other models go through an OpenAI-compatible API:

```bash
OPENAI_API_KEY=sk-... jig --model gpt-5 "..."                                  # OpenAI
jig --model qwen3-coder:30b --base-url http://localhost:11434/v1 "..."          # a local model (Ollama)
jig --api openai "..."                                    # DeepSeek through its OpenAI-compatible API
```

From a clone, Node runs the TypeScript in `src/` directly, so there is no build step:

```bash
npm install
npm start -- -C ~/code/some-project "the login test is failing, fix it"   # run one task
npm start -- -C ~/code/some-project                                       # interactive session
npm run build && npm link   # optional: puts this clone's `jig` on your PATH
```

```
Usage: jig [options] [task]          (a task of - is read from stdin)

  -m, --model <id>      deepseek-flash (default), deepseek-v4-pro, a Claude model like claude-opus-5-5, or
                        a model an OpenAI-compatible API serves (gpt-5, or a local model with --base-url)
      --api <format>    anthropic | openai (default: anthropic for Claude and DeepSeek, openai for others)
      --base-url <url>  the API's address, e.g. http://localhost:11434/v1 for Ollama
  -e, --effort <level>  low | medium | high | xhigh | max (default: medium for Claude models, the model's own
                        for others; DeepSeek takes low | high | max)
      --mode <mode>     when to ask before a tool call (default: edits)
                          plan   look around and plan; refuse every change
                          ask    ask before every file change, and every command that does more than read
                          edits  change files in the project freely; ask before commands the sandbox doesn't contain
                          auto   never ask
  -y, --yes             same as --mode auto
      --approve-via <url>  in a one-shot task, ask a service over HTTP where the mode would ask at the
                        terminal (see below)
      --approval-timeout <s>  deny a call --approve-via has no answer for after this long (default: 600)
      --no-sandbox      run commands directly on this machine instead of in the sandbox (Seatbelt on
                        macOS, bubblewrap on Linux)
      --allow-network   let sandboxed commands use the network
      --hide-thinking   don't print the model's thinking (/thinking toggles it in a session)
  -c, --continue        continue this project's most recent session
      --resume <file>   continue a saved session (--sessions lists them)
      --sessions        list this project's saved sessions
      --compact-at <n>  summarize the conversation once it reaches n tokens, or 80% of the model's context
                        window if that is less (default: 200000; 0: never)
  -C, --cwd <dir>       project directory (default: the current directory)
      --add-dir <dir>   let the file tools work in this directory too, and the sandbox write there
                        (repeatable; --add-dir / inside a container makes the whole system the project)
      --max-steps <n>   most steps per task, each a model call that may call tools (default: 50)
      --time-limit <s>  most seconds per task: at the limit jig stops, whatever is running (see below)
      --no-budget-notes don't tell the model, once half the steps or the time is used, what is left (see below)
      --no-early-budget-notes  start those notes only at half, not once 3 or fewer steps are left, and don't say
                        in each what a step is (see below)
      --finish-gate     at its first stop, send the model back once if it changed files after it last ran
                        anything, or its last test run failed
      --no-wrap-up      at --max-steps, stop without one more call (no tools) asking where the work stands
      --escalate <model>  once a test command the model runs fails, this model takes the steps left
      --no-subagents    leave out the subagent tool
      --tools <names>   give the model only some of jig's tools, e.g. --tools bash
      --hide-skill <name>  leave a skill out, as if it weren't installed (repeatable)
      --no-memory       leave out what jig remembers from earlier sessions
      --system-prompt <text>  use this system prompt instead of jig's own
      --stats <file>    keep a JSON file of the model calls, tokens, tool calls and mechanisms fired so far
      --events <file>   write a task's events as JSON lines as they happen (- for stdout; see below)
      --check           in a one-shot run, ask the model to check its work before it finishes
      --reviewer <model>  before the task ends, this model checks the work against the task (read-only)
      --check-writes    after write_file and edit_file, tell the model of a syntax error the change made, or of
                        lines write_file left that look like placeholders for code left out; python3, node and
                        bash check a file only where the model could run them on it unasked (see below)
      --tolerant-edits  let edit_file apply an old_string that matches one place only once curly quotes, dashes
                        and no-break spaces count as ASCII, or then trailing whitespace doesn't (see below)
      --no-overview     don't give the model, before a task, the project's files with their sizes, and the files
                        the task names as read_file shows them, which then count as read (see below)
      --no-test-notes   don't say in a command's result when its unittest or pytest run ran no tests, with what
                        didn't run after it and where unittest didn't look (see below)
      --keep-inputs     say in a command's result when a file that was there before the task is gone or empty
                        after it, with its bytes in no other file, and where a copy of it as it was then is (see below)
  -v, --version         print jig's version
  -h, --help            show this help
```

In a session: `/mode`, `/undo`, `/thinking`, `/skills`, `/mcp`, `/context`, `/compact`, `/reset`, `/help`
and `/exit`, and `/<skill> [task]` runs a skill. After each task jig prints the steps taken, the tokens
sent and received (subagents included), and how many input tokens came from the prompt cache. Up brings
back earlier tasks and commands of one line; a paste of several lines is one message, sent with Enter, and
a line ending in `\` goes on in the next. Ctrl+C stops a task, and at the prompt clears the line; on an
empty prompt it says how to quit, and pressed again it quits, as Ctrl+D does. Piped into jig, a session
takes a task or command from each line, one ending in `\` too.

A task given on the command line exits with 0 when the model finished, 1 on an error, 2 when it ran out of
steps, 3 when a reply hit the output limit or the context window, 4 when the model declined, 5 when tool
calls needed approval and there was no terminal to ask, 6 when the model was stuck repeating the same tool
calls, 7 at `--time-limit`, 8 when the model gave a second reply with no text or tool call, and 130 on
Ctrl+C. So `jig "fix the tests" && git commit -am fix` doesn't commit after a run that stopped short.

`--stats` keeps a JSON file for scripts and evaluation harnesses, rewritten as the task runs: the stop
reason, steps, model calls (the subagents' and the reviewer's in `subagentModelCalls`), tokens (theirs
included), the main loop's tool calls by name (those that didn't run included), seconds, and `events`, how
often each of jig's mechanisms fired (retries, compactions, calls that didn't run as asked, hooks' blocks,
the reviewer, the wrap-up and more: `src/stats.ts` lists them). So you can see that a change to one runs at
all: in milestone 28, two candidates' changes never ran, which only reading the sessions showed.

`--events` writes a task's events as JSON lines, one written as each happens, for a service that runs jig as
a task and follows it there rather than in the terminal's output (`-` puts them on stdout, and the terminal's
output on stderr). Each line is `{"v":1,"seq":n,"ts":"<ISO time>","type":...}` with the type's fields:
`start` (the task, `cwd`, `model`, `version`, `limits` with `maxSteps` and `timeLimit`), then for each step
`step` (its number, its call's `usage` and `cost`), the model's `text`, each `tool_call` (`id`, `name` and the
`description` the terminal shows, cut from the middle to 4,000 characters, with `"truncated":true` when
cut) and its `tool_result` (`isError`, and the `output`, cut the same way), each `notice` jig prints (errors
included), and last `end`: the stop reason, the `exitCode` jig exits with, the steps, and the `usage` and
`cost` of every model call in the task (subagents', the reviewer's, compactions' and the wrap-up's included;
the wrap-up's report is a `text` after the last step). A cost is in US dollars: each call is priced by the
model its reply names (a gateway's alias names the model behind it) when `src/prices.ts` has a price for
it, else by the one jig asked for, and is null when neither has. Every string goes through the redaction `jig sessions export` uses. A reader
should pass over a type it doesn't know: later versions may add some. It is only for a task given on the command line or stdin. The
file is opened before the task starts, written anew as `--stats`' is (a link in its place is replaced, not
written through), and written a line at a time, so a crash loses at most the last; ended by SIGTERM, SIGHUP,
a Ctrl+C before the task starts or a second one in it, jig still writes an `end`, its stop `interrupted` (and
`error`, with exit code 1, after a failure nothing caught). With `-`, what the pipe can't take while its
reader is behind waits in jig, each later line behind it, and jig goes on with the task: a reader that stops
reading holds the events, not jig, which still acts on a signal. jig holds 64 MiB of them at most: past that
it drops new events (not the `end`; not always in a row, as a smaller one may still fit), and says how many on stderr and, where there is room by then, in a
`notice` before the `end`. When jig ends, however it ends, it writes what it holds, waiting for the reader as
long as it takes some every 5 s, and after a signal 20 s at most in all, once its commands are killed; a
second signal in that wait doesn't cut it short (at any other end, Ctrl+C still does). If it gives up, it
says on stderr how many events it couldn't write, and exits: the last line it wrote may then be cut off, so
a reader should drop a last line without a newline. So a reader that is behind but reads loses no line, the
`end` included, on Linux or macOS. If the reader closes the pipe, or a write jig tries again fails
otherwise, jig says so on stderr, writes no more events, and goes on with the task. `--events /dev/stdout`
isn't `-`: jig opens it as a file, whose writes can wait for the reader, signals with them, and the
terminal's output goes there too.

`--approve-via <url>` is for a task no one runs at a terminal but a person should still approve, as the
task service runs it with approvals on ([docs/server.md](docs/server.md)). Where the mode would ask at the
terminal, jig writes an `approval_request` event (`step`, `id`: `ap_1`, `ap_2`, ..., `tool`, `description`,
cut from the middle to 64,000 characters, with `"truncated":true` when cut) and polls
`GET <url>/<id>?wait=25`, with `Authorization: Bearer <the model's API key>`, for the answer: 200 with
`{"decision": "allow" | "deny", "always": true}` (`always` optional), or 204 for none yet, asked again at
once; any other status, or a failed connection, is asked again after 1, 2, 4 ... seconds, 10 at most, and
the first of these for a call is a `notice` (the status, or why it couldn't connect). `allow` is the
terminal's yes, with `always` its always, and `deny` its no; with no answer after `--approval-timeout`
seconds (600) the call is denied. An `approval` event (`id`, `decision`, `always`: true only where jig
remembered it, as where the terminal offers always; `by`: `api`, or `timeout`) follows, and the task goes on
as after the terminal's answer. `--time-limit`, Ctrl+C and SIGTERM stop the wait as they stop the task. It
is only for a task given on the command line or stdin, with `--events` (the service learns of a call from
its event), not with `--yes` or `--mode auto`, which never ask, and the address can't have credentials, a
query or a fragment.

`--check-writes` checks what `write_file` and `edit_file` wrote, and adds what is wrong to their result: a
syntax error the change made in a Python, JavaScript, shell or JSON file (python3's `ast.parse`,
`node --check` and `bash -n`, run as commands are, for 5 seconds at most and only where they are installed;
`JSON.parse` in jig), but not one the file had before; and lines like `// ... existing code ...` that
`write_file` left in a file it made at least a quarter shorter, which stand for code a whole-file rewrite
dropped. python3, node and bash check a file only where the model could run them on it itself without
asking: in `auto` mode (`--yes`, `--mode auto` or `/mode auto`), in `edits` mode where the sandbox contains
commands (so not without it, nor with the network, by `--allow-network` or the settings' `"network": true`),
or where an allow rule or an `[a]lways` answer allows the program. Never where a deny rule matches the
program on the file or the script the check runs (`python3 -I -S -c '...' <file>`, so a rule `python3 -c`
holds), where a `PreToolUse` hook covers `bash` (jig can't ask a hook about a command the model didn't
make), or where `--tools` leaves `bash` out. Elsewhere those checks are left out, since the model can
choose what they run: a virtualenv's `python3` first on the PATH, and what it runs as it starts, can be
files the model wrote. jig tells you once why it left one out, and `--stats` counts each as
`write.checkSkipped`. python3 runs with `-I -S`, which leaves out the project's modules, `.pth` files and
`sitecustomize`, but not everything an interpreter the project holds does as it starts (a virtualenv's
`pyvenv.cfg` can point it at a standard library the model wrote): what keeps such a program to where the
model could run it anyway is the rule above, not `-S`. It is off until benchmarks show whether it helps;
`--stats` counts what it finds.

`--tolerant-edits` lets `edit_file` apply an `old_string` that isn't in the file but matches one place once
curly quotes, en and em dashes and no-break spaces count as their ASCII look-alikes, or failing that, once
trailing whitespace on each line doesn't count either. Indentation always counts, an exact match comes
first, and a looser one applies only where it is the only one; the result says what was ignored, and
`--stats` counts it as `edit.tolerant`. It is off until benchmarks show whether it helps: deepseek-flash's
edits rarely fail at all (2 of 1,709 in the stored benchmark runs of milestone 4 and later), unlike
milestone 27's 7B models' (527 of 623).

The overview puts two things before a task, with no model call (`--no-overview` leaves them out): in a
conversation's first message, the project's files, shallowest first, with their sizes (200 at most, leaving
out what `glob` leaves out); and with each task, the files it names (a word with a dot or a slash that is a
file's path, or the name of only one file) as `read_file` shows them, up to 16 KB each and 32 KB in all,
line numbers included (a larger file, or one that isn't UTF-8 text, is named but not shown). Those shown
count as read, so `write_file` can replace them without a read first; the note says so only where
`write_file` is among the model's tools and neither plan mode nor a deny rule refuses it. Not in the home
directory or at the root, nor in the requests jig writes itself (`/reflect`, say). Each part only where the
model's own `glob` or `read_file` would show it unasked: not where `--tools` leaves that tool out, a deny
rule names it, or a `PreToolUse` hook covers it (jig can't ask a hook about a call the model didn't make).
jig tells you once why it left a part out, and `--stats` counts each task it left one out of as
`overview.skipped`. It runs in the task, so Ctrl+C and `--time-limit` stop it. The task is the message
without the files: the reviewer and the Stop hooks get it (jig's notes stay in it), `jig review` and
`jig sessions list` the request alone, and a compaction keeps or restates it, since it forgets what the
model read. In milestone 30's runs on evolve2's 4 steps, the model spent its first two finding and reading
the files, the test file a step after those the task named, so its first write came at step 3 or 4. It is
on by default since milestone 31: on evolve2's 4 steps, the overview, the early budget notes and the test
notes (below) together passed 290 of 315 attempts in three runs (two of them with a fourth change, since left
out), against 268 of 315 for three baselines
(+7 points, 95% interval +0.6 to +13.3), while none of them alone beat the noise. `--stats` counts it
(`overview`, and `overview.file` for each file shown).

The test notes add a line to a command's result when unittest or pytest ran no tests in it
(`--no-test-notes` leaves it out), by what they print (pytest's errors collecting them too) or by their exit
code 5 (unittest's from Python 3.12): that no tests ran; where the command's last runner, which then exits
with an error, was followed by `&&`, that the commands after it didn't run (not where the command exited
with 0 and that `&&`'s list came last, since what followed then ran); and for unittest, which folders hold
`test*.py` files but no `__init__.py` where it ran (the project, or where a `cd` to a path written out took
it; none after another `cd`, or one in a pipeline or the background), which its discovery doesn't enter
(five at most; not one the settings hide, or the command already starts it in or names a file or module
in), and that `unittest discover -s <folder>` starts it there. Not where the command runs another kind of
runner too (`go test`, `npm test`), whose tests may have run. In milestone 30's two evolve2 runs with
budget notes, 29 of 210 attempts ran unittest from the project, whose `tests/` has no `__init__.py`, 27 of
them on their last step; in 22 the model's own checks (`python - <<'PY'`) came after its `&&` and didn't
run either, which the result didn't say. They are on by default since milestone 31 (see the overview,
above); `--stats` counts each note (`bash.noTests`).

`--keep-inputs` watches the files that were there before the task (5,000 at most, the shallowest first) and
adds a line to a command's result when one that wasn't empty is gone or empty after it, if it was as it was
before the task until that command (not after `write_file`, `edit_file` or an earlier command changed it)
and no other file in the project holds its bytes (a backup the model made, say). The line says where a copy
of it as it was before the task is: a file in the temp directory with a random name, made as the long
outputs' files are and deleted with them when jig exits. jig never puts the file back itself, and says it
is gone after the command, not that the command removed it: a job left in the background can do that too.
The copy comes from the task's snapshot or, where there is none (no git, as in most of milestone 30's
Terminal-Bench trials), from a store jig makes at the task's start in `~/.jig/inputs/` (in the task, so
Ctrl+C and `--time-limit` stop it): each file gzipped and named by its SHA-256, leaving out what snapshots
leave out and what the project's `.gitignore` files ignore (as far as jig reads them without git), 20 MB a
file and 100 MB in all, only the latest task's files, and removed when jig exits. A file past those is named
without a copy, as is one the snapshot holds other bytes for (git made its line endings LF, as `* text=auto`
in `.gitattributes` has it do, say); any file of its size then counts as its backup. In milestone
30's db-wal-recovery, the model's first look at the database with `sqlite3` deleted the task's only copy of
its data, a write-ahead log with an invalid header; replayed with the task's files, the line gives that log
back byte for byte. It is off until benchmarks show whether it helps; `--stats` counts each file named
(`inputs.lost`), each without a copy (`inputs.copySkipped`), and each one gone or empty it kept quiet about
(`inputs.suppressed`).

## As a library

A program can run jig's tasks itself, without a process for each: `runTask` runs one as
`jig --events - "task"` would, and resolves to how it ended.

```js
import { runTask } from "jig-agent";

const controller = new AbortController();
const result = await runTask({
  prompt: "the login test is failing, fix it",
  cwd: "/work/some-project",
  model: "claude-opus-5-5",
  signal: controller.signal,                    // abort() stops the task: it ends "interrupted"
  onEvent: (event) => console.log(event.type),  // start, step, text, tool_call, tool_result, notice, end
  approve: async (request) => ({ decision: "allow" }), // request: {id, step, tool, description}
});
// { stop: "end_turn", exitCode: 0, steps: 4, usage: {...}, cost: 0.0123, seconds: 21.4, text: "Fixed ..." }
```

`prompt` and `cwd` are needed; the rest are as their flags: `model` (`deepseek-flash` without one),
`baseUrl`, `maxSteps` (50), `timeLimit` (seconds), `mode` (`edits`), `yes`, `sandbox` (false is
`--no-sandbox`) and `stats` (the file's path; a relative path, like a relative `cwd`, is from the process's
working directory). `apiKey` is the key, or without one the environment variable jig uses for the model;
`home` is jig's directory for the task (`JIG_HOME`: its sessions, snapshots, memories and settings), or the
process's; `env` is the environment its commands and hooks get (less the API keys), and its MCP servers
their `HOME`, `PATH` and the like from, or the process's; it is also where `JIG_TRUST_PROJECT` is read, so
pass it in `env` to trust a project's settings without a terminal. Each event is the object `--events`
would write as a line (see above). `approve` is asked where the CLI would ask at a terminal, before a tool
call the mode doesn't allow, with the call's `id` (`ap_1`, `ap_2`, ...), `step`, `tool` and `description`:
`allow` is the terminal's yes, `allow` with `always: true` its always, `deny` its no. Without `approve` or
`yes`, such a call is refused as with no terminal, and the third ends the task `unapproved`. Each call put
to `approve`, and its answer, are `approval_request` and `approval` events, as `--approve-via`'s are. If
`approve` rejects, the call doesn't run (its result tells the model the permission check failed, with the
error's message), its `approval_request` gets no `approval` event, and the task goes on. `exitCode` is what
`jig` would exit with. A failure ends the task with `stop: "error"` and says what failed in `error`, as
does an `onEvent` that throws; only options that are wrong, before it starts, and an `onEvent` that throws
at the end event reject. A signal aborted while the task is still starting (connecting MCP servers, taking
its snapshot) stops it once that is done. A task prints nothing, and leaves the process's signal handlers,
exit code and working directory alone. Several can run at once in one process, each with its own project,
jig directory, model and API, and each sees only its own events, permissions, memories, sessions and stats:
what the CLI leaves to the process is the task's own in a library ([`src/context.ts`](src/context.ts)), but
for the skills in your home directory's `.agents/skills` and `.claude/skills`, `~/` in hiddenPaths and the
home-directory checks, which are the process's, as `HOME` is. The CLI runs the same code
([`src/run.ts`](src/run.ts)), so the two can't drift. The package ships its types, which use Node's
(`@types/node`).

## What it does

### Safety

- **Sandbox.** Commands run in the operating system's sandbox, as in Codex and Claude Code: Seatbelt on
  macOS, [bubblewrap](https://github.com/containers/bubblewrap) on Linux. They can read anything but jig's
  own directory and the hidden paths (both below), and write only inside the project, its git directory
  (not its config or hooks, which name programs git runs, nor its submodules', nor the files that tell git
  where they are: worktrees' and submodule checkouts' `.git` files, `commondir`, `config.worktree`,
  `gitdir`), the directories added with `--add-dir` and the temp directories, and they can't reach the
  network. A bare repository's config and hooks stay writable, unless it has linked worktrees or is named
  `.git`: setting up a server's hooks can be the task. Those files of a repository around the project's
  that lie where commands can write (a submodule checkout's `.git` in the project, say, or its config in a
  temp directory) stay read-only too, so a repository a command makes in the project doesn't unlock them.
  Where a repository's git directory lies in a directory commands can write in (a clone in a temp
  directory, say), they can't move aside the directories holding it there either, to put another in its
  place. Some changes to git's files aren't refused, so jig warns of them after the task and when a
  session ends: on Linux, a `commondir` or `config.worktree` that wasn't there (one can't be made
  read-only without creating it, and an empty `commondir` breaks git); on both systems, a submodule's
  checkout moved aside and another put in its place (on macOS, a link to one), a `.git` made in the
  project, or the project made a git directory (`git init --bare .`), when jig was started in a
  subdirectory of a repository (the same in a directory between them; making a repository can be the
  task), and a git directory's `HEAD`, `objects` or `refs` removed or broken (git changes them all the
  time, so commands can too). Your git would then take its config from elsewhere, or pass over the
  directory and fail or use a repository above it, so look before you run git there; jig still finds the
  repository by its `.git`, so the next session keeps its config read-only. A job a command leaves in the
  background can still do so after jig has looked: on Linux until jig exits, on macOS after that too.

  Commands can't read jig's own directory (`~/.jig`, or `$JIG_HOME`) but for its skills, whose scripts the
  model runs, nor can the file tools: its sessions and snapshots hold copies of your projects' files, and
  the snapshots older versions of jig took hold the hidden paths too (see Rules). Neither can change
  anything in it, its skills included, even in a home-directory project: each skill there is offered in
  every project. If `~/.jig/skills` is a link out of it (into a dotfiles repository, say), both change
  them where the link leads, like any other files there. A project or `--add-dir` directory inside it (a
  skill you are writing, say) stays as it was. Where it lies in a directory commands can write in (a
  `JIG_HOME` in a temp directory, as `jig skills test` sets one), they can't move it aside either, nor
  that directory, nor one in it holding it.

  On macOS, localhost stays open; on Linux each command gets an empty network of its own, so a test can
  still start a server and talk to it, but only within one command. Only IP networking is cut off, though:
  a daemon listening on a Unix socket (Docker's, say) is still within reach. On macOS commands share the
  machine's processes, so they can see yours and signal them, and a job a command leaves in the background
  runs on after jig exits. On Linux they run in one PID namespace for the session with a `/proc` of their
  own, so they see only the session's own processes, not yours, and can't reach outside the sandbox through
  `/proc/<pid>/root` of a process that is outside it. A job a command leaves in the background runs on
  until jig exits, when the whole namespace ends and the job with it: the next command can find it in
  `/proc` (a `sleep`, say), but can reach a server left running only with the network allowed, since
  otherwise each command has a network of its own. Where bubblewrap is too old to set this up, or the
  kernel won't let it, each command gets a namespace of its own instead and a background job ends with the
  command that started it, which jig says once. Because a sandboxed command can't change files outside the
  project or reach the network, in the default `edits` mode commands run without asking (a hook that runs
  the project's code runs outside the sandbox: see Hooks). `--allow-network`, or `"network": true`, lets
  them reach it, so a command that does more than read then asks first. On Linux the sandbox needs
  bubblewrap installed (`sudo apt install bubblewrap`), user namespaces allowed and, in a container, a
  `/proc` it may mount (Docker and Podman mask parts of theirs unless run with `--privileged`, or
  `--security-opt systempaths=unconfined` and `unmask=ALL`); where it can't run, jig says why, and commands
  ask first. `--no-sandbox` turns it off.
- **File tools.** `read_file`, `grep`, `glob`, `write_file` and `edit_file` run in jig itself, outside the
  sandbox, so they keep to the project and the `--add-dir` directories on their own. A change goes by where
  its path really leads, so a symlink in the project can't take it outside; reading may follow a link out,
  as commands can read what it leads to too. But wherever a link leads, and with the sandbox off too, they
  refuse what the sandbox hides from commands: the hidden paths in the settings (below), and jig's own
  directory but for its skills, which they read but don't change. So does the `skill` tool, for a skill's
  files, and so does finding skills: one whose `SKILL.md` leads there is left out, with a warning (another
  project's memory has a name and a description too). They don't change a `.git` directory's `config` or
  hooks, or the files that tell git where they are (`.git` files, `commondir`, `config.worktree`, a
  worktree's `gitdir`), which could make git run programs outside the sandbox; nor what the sandbox keeps
  read-only in a git directory by another name (one made with `--separate-git-dir`, say), with the sandbox
  off too. An approved AGENTS.md edit goes by real path too (the question names the file an AGENTS.md link
  leads to), and so do a skill the model wrote and what `jig skills add`, `update` and `remove` change in
  the project, which also never go into a path the settings hide or a `.git` directory, where a skill's
  folder could be a submodule's git directory, nor into what the sandbox keeps read-only in one by another
  name, nor replace a folder holding it. `jig skills` refuses a name in the lockfile that isn't a skill's
  name, since commands can write the lockfile; `update` says why it skips an entry it refuses or can't
  fetch, updates the rest, and exits non-zero. An entry can point anywhere, so its question names the URL
  or folder a skill would come from; it refuses a folder, or a file URL's repository, that the hidden paths
  hide or that holds one, and, with paths hidden, has git read a file URL's repository in the sandbox,
  where there is one, which hides them from git too (a `.git` file in it can lead git elsewhere). `add`
  does the same, so it doesn't install what `update` would refuse, and both take only https, ssh and file
  URLs (git runs a program for some others, and http and git URLs don't check whom they reach). The
  `--stats` file and the project's skills lockfile are written anew and renamed into place, which replaces
  a link or a named pipe instead of writing through it (a linked folder on the way is still followed, as is
  a link in place of your own lockfile, which commands can't write); a `--stats` path in `/dev` or `/proc`,
  such as `/dev/stdout` or a process substitution's `/dev/fd/63`, is written to. What jig reads from the
  project to work in it (AGENTS.md, skills, the settings, the git files the sandbox watches, the skills
  lockfile and the installed skills' files) it reads only if it is a regular file: a named pipe a command
  made there would have jig wait until it was killed, and a link to `/dev/zero` never ends. Such an
  AGENTS.md or skill is left out, and jig says so; in place of such an AGENTS.md it follows, and proposes
  edits to, the `CLAUDE.md` beside it, if that is a regular file. An approved edit is written only to a
  regular file too, so a named pipe a command makes there while you read the diff is refused. A settings
  file is refused, a lockfile or a skill's file is reported and its skills left as they are, and a git file
  is reported by what it is. `read_file` and `edit_file` likewise open only a regular file, and tell the
  model so. `grep` and `glob` leave out what git ignores, and folders like `node_modules/`, `dist/` and
  `build/` that git doesn't track, but search such a path when they are given it (`node_modules/pkg`, all
  of it if git ignores it). The git they run to list files runs with `core.fsmonitor` and hooks turned off;
  each run stops with the task, or after 30 seconds, and they then walk the files, since a named pipe where
  git reads (a `.gitignore`, `.git/info/exclude`, a nested repository's config) would have it wait forever.
  After the 30 seconds they tell the model that what git ignores may be among the files. `grep` matches in
  a worker thread that Ctrl+C stops, as do 30 seconds on one file, since a regular expression can take
  exponentially long on some lines. `edit_file` and `write_file` change only UTF-8 files: for a Latin-1 or
  UTF-16 file the model is told to use a command, and `read_file` says when what it shows isn't UTF-8.
  `read_file` reads a file a chunk at a time and keeps only the page it shows: 5 lines of a 300 MB log used
  to take 800 MB of memory. `edit_file` and `write_file` refuse a file over 537 MB, V8's longest string,
  and say to use a command.
- **Modes.** `plan` only looks: file changes and commands that change things are refused, and the model is
  told to propose a plan. `ask` asks before every change and command, `edits` (the default) lets file
  changes and contained commands through, and `auto` never asks. Reading never asks: `read_file`, `grep`,
  `glob`, and commands that only read inside the project (`ls`, `cat`, `sed -n 10,20p`, `git diff`, ...).
  When jig does ask, `[a]lways` approves that program (say, `python3`) for the rest of the session. On a
  file change it approves file changes only: commands still ask, even ones the sandbox contains.
  With no terminal to ask in (a script, CI), such a call is refused instead, and the third in a task
  stops it: `--yes`, or allow rules, let them run, and `--approve-via` asks a service instead (see above).
- **Rules.** `~/.jig/settings.json` and the project's `.jig/settings.json` can list commands to always
  allow or always refuse:

  ```json
  { "allow": ["npm test", "make"], "deny": ["git push", "npm publish"] }
  ```

  A deny rule is refused in every mode, even `auto`, and matches its words in order within one command, so
  `"git push"` also catches `git -C repo push origin` and `bash -c "git push"`. A deny rule can also name a
  tool, like `"mcp__github__merge_pull_request"`. The settings can also hold `"sandbox": false` or
  `"network": true` for a project, and `"hiddenPaths"`: files and folders sandboxed commands can't read at
  all, like `["~/.ssh", "~/.aws"]` (the model is told that some paths are hidden, not which). They are
  hidden by their paths, so where one lies in a directory commands can write in (the project, say), they
  can't move aside that directory, nor one in it holding the path. Snapshots leave out those in the
  project, by where they really lead, and `/undo` leaves them as they are (with the project itself hidden,
  `/undo` is off).
- **Project trust.** A repository's `.jig/settings.json` could start programs (hooks, MCP servers) or
  loosen the sandbox the moment you run jig in a repository you just cloned. So those parts only apply
  after you say yes to a prompt listing exactly what they would do; the answer is remembered for that
  version of the file, and any change asks again. Until then only its deny rules and hidden paths apply,
  since they only restrict. With no terminal to ask in, `JIG_TRUST_PROJECT=1` trusts it.
- **Undo.** Before each task, jig snapshots the project's files into a private git repository in
  `~/.jig/snapshots/` (so it works in any folder and never touches the project's own git history), and
  `/undo` puts back every file the task changed, created or deleted, whether through the file tools or a
  command. `/undo` again goes one task further back. Snapshots leave out, and `/undo` leaves as they are,
  files git ignores (a `.env`, say), what is in `node_modules/`, `dist/`, `build/`, `.jig/` and the like,
  and files inside a nested repository (a submodule, a clone), where git would run programs that
  repository's config names. Projects with more than 200 MB of files that aren't ignored aren't
  snapshotted: the size is checked before every task, and a project that grows past it (a task downloads a
  dataset, say) turns `/undo` off for the rest of the session. So does git still taking a snapshot after 60
  seconds, which is stopped: git waits as long as a named pipe is where it reads (a `.gitignore`, say), and
  a command can make one. Snapshots are never signed and run no hooks, whatever your git config says. When
  `/undo` fails (a lock another git left, say), it says why and keeps the snapshot, so you can try again.
- **Credentials stay with jig.** Commands the model runs, hooks and the git jig runs on the project get
  jig's environment without its API keys (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `OPENAI_API_KEY`). They never need them, and a model that runs `env` to look around, as both agents did
  on Terminal-Bench, would otherwise put the key in the conversation and the logs, within a prompt
  injection's reach.
- **Prompt injection.** The system prompt tells the model that text in files and command output is data,
  not instructions, and to tell the user when it finds instructions there. The sandbox and the deny rules
  are what protect you when that isn't enough.

### Context

- **AGENTS.md.** jig reads `AGENTS.md` (or `CLAUDE.md` where there is none) from every directory between
  the repository root and the working directory, and puts it at the end of the system prompt, the most
  specific file last. Build commands, conventions and gotchas written there apply to every session.
- **Sessions.** Every message is appended to a JSON Lines file in `~/.jig/sessions/<project>/` the moment
  it exists, so nothing is lost on a crash or Ctrl+C. `jig -c` continues the most recent session,
  `jig --sessions` lists them, `jig --resume <name>` picks one. Tool calls a crash left without results are
  answered as interrupted when a session is loaded, so the history is always valid. Each line after the
  first, which records the session's start (the date, the model, the system prompt and the tools), says
  when it was written (`at`); a reply, how long its model call took, retries included (`ms`); and tool
  results, how long each call took (`toolMs`), in milliseconds, so a session shows where the time went. A
  project's directory there, as in `~/.jig/memory/` and `~/.jig/snapshots/`, is named after its real path
  and a short hash of it: a symlink to a project shares its sessions, and `/a/my-app` and `/a/my/app` no
  longer do. What was kept under the older name, the path alone, moves to the new one the first time, if
  the sessions saved there show it was this project's.
- **Compaction.** jig tracks how many tokens the conversation takes up (measured from each reply's usage,
  estimated for tool output since, and from the text's length when a server reports no usage). Past
  `--compact-at`, or 80% of the model's context window if that is less (as jig takes it: 1M tokens for
  Claude and DeepSeek, 200k for Haiku, 128k for others), it asks the model to summarize the conversation
  and continues from that summary; `/compact` does it on demand and `/context` shows the numbers. Mid-task,
  the task's own words and a list of the file changes and commands so far follow the summary. When the API
  rejects a request as too long for the model, jig compacts and asks again, once (not with
  `--compact-at 0`). The conversation is then too long to summarize as well, so the summary is written from
  a copy with the tool output cut to its start and end, the oldest first (`/compact` does the same when the
  API rejects its request). Past `--compact-at`, a summary that fails doesn't end the task: it goes on as
  it is, and compaction is tried again 3 steps later. One that fails after the API's rejection ends it.
- **Long output.** Tool output over 40,000 characters (about 10k tokens), and a command's over 39,000, is
  cut from the middle, keeping its start and its end (errors and test summaries tend to be at the end). A
  command's whole output then goes to a file in the temp directory that only you can read, and the model is
  told where, so it can search what it didn't see instead of running the command again. Commands that only
  read one of these files while jig keeps it (`grep -n`, `sed -n 10,20p`, `tail`, ...) count as reading
  inside the project, even in plan mode; other files with names like theirs don't. The files hold 100
  million characters at most, the oldest making room, and jig deletes them when it exits. However much a
  command prints, jig keeps only its start and end in memory, so the command runs to the end.
- **Memory.** jig keeps what a session showed that later ones should know, each item with your approval.
  User memories (how you like to work) hold in every project; project memories (facts about a project
  that its code doesn't say) in that one. Both are Markdown files under `~/.jig/memory/`, one per memory,
  outside the repository; the system prompt lists them by name and one-line description, newest first,
  and the `memory` tool reads one in full. Conventions every agent working on a project should follow
  belong in its AGENTS.md instead, and jig proposes edits to it as diffs.

  ```text
  /remember tests run with make check, never pytest directly      in a session: proposes a memory
  /reflect                     proposes what this conversation should leave behind: memories, AGENTS.md edits
  /memory                      lists what jig remembers
  jig memory reflect           the same for your last session here (--yes keeps every proposal, for scripts)
  jig memory list | show <name> | remove <name>
  ```

  The model proposes with `propose_memory` and `propose_instructions`; jig checks each proposal (a memory
  is one fact, its description one line, and nothing that looks like a secret), shows it to you, and keeps
  it only if you say yes. Memories were true when saved, so the prompt asks the model to check one that
  names a file, function or command before relying on it, and to propose forgetting one that turned out
  wrong. `--no-memory` leaves memory out. What counts as a secret here: a key or token in the shape a
  provider gives out (`sk-`, `ghp_`, `glpat-`, `hf_`, `AIza` and others), a private key, a password
  assignment (`password=…`, `DB_PASSWORD=…`, `PGPASSWORD=…`, `"api_key": "…"`, but not a placeholder like
  `${DB_PASSWORD}`, code that reads one, like `os.environ["DB_PASSWORD"]`, or a variable or a type, like
  `this.authToken = authToken;` or `token: CancellationToken,`), and a password in a URL, unless its host
  is this machine or an example (`postgres://postgres:postgres@localhost` is fine). `jig sessions export`
  blanks out the same, and JWTs, but a password assignment only when its value has a digit in its first 100
  characters and doesn't look like code (`token = tokens[i]`).

### Extensions

- **Skills.** jig reads [Agent Skills](https://agentskills.io): folders with a `SKILL.md` (a name and a
  description in YAML frontmatter, then instructions) and maybe scripts and reference files. They are found
  in `.jig/skills`, `.agents/skills` and `.claude/skills`, in the project and in your home directory, then
  among jig's own (`skill-writer`), the project's winning on a name clash. jig's own skills are for writing
  skills, so a plain one-shot task leaves them out and a benchmark measures what it did before. Loading is
  progressive: the system prompt lists only each skill's name and description; the model calls the `skill`
  tool to load the instructions when a task matches, and reads its other files only if the instructions
  point to them. `/<skill> [task]` loads one yourself. Skills can be installed, written and measured:

  ```bash
  jig skills add anthropics/skills/skills/pdf      # from GitHub: owner/repo/path[@ref], a git URL, or a folder
  jig skills add anthropics/skills/skills --skill mcp-builder --project   # one skill of a collection, for this project
  jig skills list                                  # where each skill comes from, and how often it was used
  jig skills update                                # fetch installed skills again; jig skills remove <name>
  jig skills new "write release notes from the merged pull requests"   # the model writes a skill with you
  jig skills learn                                 # turn your last session here into a skill, if it holds one
  jig skills test release-notes --attempts 3       # run its evals with the skill and without it
  ```

  `jig skills add` shows what it is about to install, scripts first, and records the source and commit of
  each skill in a lockfile beside it (`~/.jig/skills-lock.json`, or `.jig/skills-lock.json` with
  `--project`); nothing runs at install. A git URL must be https, ssh or file. A skill the model writes
  (`jig skills new`, or `/skills new` and `/learn` in a session) is a proposal: jig checks it against the
  specification and shows it to you, and saves it only where you say, in the project or for all your
  projects. With no one to ask, it goes to `.jig/proposals/skills/`, a folder `jig skills add` can install
  once you have read it. A skill's evals live in `evals/evals.json`, in the format of Anthropic's
  `skill-creator` (a prompt, the expected output, expectations, input files) plus `check`, a shell command
  whose exit code says whether the result is right; `jig skills test` runs each eval in a fresh project
  with its own home directory, once with the skill and once with it hidden (`--hide-skill`), and grades it
  by the check and by the model judging the expectations. The eval hides what a session in your project
  hides, and all of your jig directory; the check, and git's look at the changes for the grader, run in
  the sandbox too, without jig's keys. An eval's input files must lie in the skill's folder, and not in a
  hidden path, in jig's own directory (but for its skills) or among git's config and hooks, or jig won't
  copy them; a file of the skill that the settings hide is left out of its copy, and a link to another
  file copied leads to that file's copy.
- **MCP servers.** jig is an MCP client over stdio, on the official TypeScript SDK. Servers configured in
  the settings start with jig, and their tools join jig's own as `mcp__<server>__<tool>`:

  ```json
  { "mcpServers": { "tracker": { "command": "node", "args": ["tools/tracker-server.mjs"], "env": {} } } }
  ```

  A tool the server marks read-only runs like jig's own read tools; any other asks first (outside `auto`
  mode) and is refused in `plan` mode, because it acts outside the sandbox's reach. `[a]lways` approves one
  tool for the session; allow and deny rules can name tools too. A name keeps only letters, digits, `_` and
  `-` (the rest become `_`) and 64 characters, so two tools can come out with the same one (servers
  `db.prod` and `db prod`, say). Then each gets a short hash of its server's and its own name, jig says so,
  and `/mcp` shows each one's server; a deny rule or hook naming their shared name applies to each.
- **Hooks.** Commands that run around tool calls, and before a task ends, set much as in Claude Code but
  flatter: each hook is one `{"matcher", "command"}`, and a matcher names jig's tools (`bash`,
  `edit_file`), not Claude Code's. Claude Code's nested form (`"hooks": [...]`) is an error, and jig
  doesn't start; a hook for an event jig doesn't have (`SessionStart`, say) is left out, with a warning:

  ```json
  { "hooks": {
      "PreToolUse":  [{ "matcher": "bash", "command": "./scripts/check-command.sh" }],
      "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "ruff check \"$JIG_FILE\" 1>&2 || exit 2" }],
      "Stop":        [{ "command": "npm test 1>&2 || exit 2" }] } }
  ```

  `matcher` is a regular expression for whole tool names; `"*"`, or no matcher, matches every tool. A hook
  gets the call as JSON on stdin, plus `JIG_EVENT`, `JIG_TOOL`, `JIG_FILE` and `JIG_PROJECT_DIR`. Exit code
  2 from a `PreToolUse` hook blocks the call and its stderr tells the model why; from a `PostToolUse` hook,
  its stderr goes to the model with the result (a linter's complaints, say). A long stderr is cut from the
  middle, as tool output is, and isn't kept in a file; jig holds only its start and end, however much a
  hook prints. Any other failure is shown to you and otherwise ignored; a hook still running after 60
  seconds is stopped, with everything it started, as is one still running when jig exits. Hooks are your
  own commands, so they run outside the sandbox, as you. One that runs the project's own code, as both
  `./scripts/check-command.sh` and `npm test` above do, runs whatever the model's commands changed there: a
  command the sandbox kept from writing outside the project can rewrite a test for the Stop hook to run,
  unsandboxed, before you have seen the change.

  A `Stop` hook runs when the model gives its final answer with a step left (and, once one has sent the
  model back, on the last step too, only to say whether it still objects), so a project can say what done
  means: its tests pass, its linter is quiet. It takes no matcher, and gets JSON on stdin with the task,
  the answer (`last_message`), `stop_hook_active` (whether a Stop hook has sent the model back already in
  this task), `session_path` and `changed_files` (what the task changed, by its snapshot, so not what
  snapshots leave out). Exit code 2, or `{"decision": "block", "reason": "..."}` on stdout, keeps the task
  going: the model is told the stderr or the reason, and works on. A long reason (a whole test log, say) is
  cut from the middle, as stderr is; a decision over 4 million characters isn't read, and jig says so. A
  task's Stop hooks send it back 3 times at most; after that, or when one still objects on the last step,
  the task ends as finished, with a notice that the hook still objects. The 60 seconds apply here too: a
  test suite that takes longer is stopped, and doesn't hold the task up.
- **Subagents.** The `subagent` tool hands a research task (where is X handled, which files would a change
  touch) to a fresh agent loop with a context of its own. It gets the tools that only look, and `bash`
  under `plan` mode's rules, never asks you anything, and returns only its findings, so the files it read
  don't fill the main conversation. Several subagent calls in one reply run at the same time.

### Improving itself

What jig can change about itself, and who decides whether it does:

| what | how | who decides |
|------|-----|-------------|
| its skills | `propose_skill` (`jig skills new`, `/learn`), measured with and without by `jig skills test` | you, when jig shows it to you |
| what it remembers, and a project's AGENTS.md | `propose_memory` and `propose_instructions` (`/remember`, `/reflect`) | you, one proposal at a time |
| its prompts, tools and loop | `npm run evolve -- run`: jig changes a copy of its own code, and a referee measures the change on benchmark tasks it wasn't made from | the referee, then you, by merging its branch or not |
| its model | `jig sessions export` writes conversations as fine-tuning data; `bench/export.ts` writes only the benchmark attempts that passed their hidden tests, and `bench/dataset.ts` a training set from every run's, split by task (milestone 26); `bench/train/` trains a LoRA of a 7B model on it on Modal, serves it, and measures jig driving it (milestone 27) | whoever trains a model: jig doesn't |

```bash
node bench/run.ts --suite evolve2 --attempts 3 --label baseline   # the baseline: 21 tasks, 3 attempts each
npm run evolve -- split       # training and held-out halves, and how often the referee would be fooled
npm run evolve -- analyze     # the model's diagnosis of the training attempts (bench/evolve2/analysis.md)
node bench/run.ts --suite evolve2 --attempts 3 --label baseline-2 # the baseline again, to compare with
npm run evolve -- calibrate   # how often the referee would be fooled, from both runs
                              # (--compare-with baseline-a,baseline-b: once jig has changed, the fresh runs)
npm run evolve -- run         # a candidate for each cause found: jig changes itself, the referee judges
npm run evolve -- tbcheck <n> # an accepted candidate on Terminal-Bench, outside DeepSeek's peak hours
npm run evolve -- list        # every candidate, its change and the verdict (--suite evolve: milestone 14's)

jig sessions export --out sessions.jsonl                                  # --all: every project's sessions
node bench/export.ts bench/results/evolve/<run>.json --out passed.jsonl   # attempts that passed, only
node bench/escalation.ts bench/results/evolve2/<run>.json eval/jobs/<job>   # where --escalate would hand over
eval/run.sh <job> jig --ak run_reviewer=deepseek-flash   # Terminal-Bench, each trial reviewed by running the work
eval/.venv/bin/python eval/review_before.py eval/jobs/<job>   # and the hidden tests on the work before the review's fix
node bench/dataset.ts                     # a training set from every passed session (bench/dataset/)
bench/train/run.sh <work dir>             # and a LoRA of a small model on it, on an Apple Silicon Mac
modal run bench/train/modal_train.py      # or of Qwen2.5-7B-Instruct, on an H100 at Modal (pip install modal)
JIG_SERVE_KEY=<token> modal deploy bench/train/modal_serve.py   # served with vLLM, beside the base model
JIG_SERVE_KEY=<token> bench/train/eval.sh <url>   # jig driving each on every suite's held-out tasks
node bench/train/compare.ts               # the two, paired by task
```

A candidate works on a copy of jig without the benchmarks, in a repository with no history, and may
change only `src/` and `skills/`; the referee runs from the main checkout, so nothing a candidate
changes can change how it is judged. In [docs/milestones.md](docs/milestones.md), milestone 14 describes
the loop and what it found, milestone 15 the suite it runs on now, whose tasks are judged at a budget of
4 steps, milestone 16 the first change it accepted, milestone 17 why that change wasn't merged (it cost
Terminal-Bench 15 points), and milestone 18 a cheaper check that would have let it through.

## How it works

```
 task ──▶ messages ──▶ model (streamed) ──▶ reply has tool calls? ── no ──▶ done
             ▲                                    │ yes
             │                                    ▼
             │   for each call: check input ▶ PreToolUse hooks ▶ permission policy ▶ run
             │                  ▶ truncate output ▶ PostToolUse hooks
             │   (calls run at the same time if all of them only read, else in order)
             │                                    │
             └──── all tool results, in one message ◀┘
```

| File | What it does |
| --- | --- |
| [`src/agent.ts`](src/agent.ts) | The loop: call the model, run the tools it asks for, send back the results, until it answers without a tool call; compact when needed; with `--escalate`, hand over to a stronger model once a test run fails |
| [`src/review.ts`](src/review.ts) | `--reviewer`: a second model, as a read-only subagent, checks the work against the task before it ends; and the prompt, verdict and re-check of a review that runs the work |
| [`src/review-cli.ts`](src/review-cli.ts) | `jig review`: a review of finished work that runs it, its commands going into a copy of the machine through `--exec`, for an evaluation harness to call |
| [`src/conversation.ts`](src/conversation.ts), [`src/session.ts`](src/session.ts), [`src/paths.ts`](src/paths.ts) | A conversation's messages, size and saved session file; where jig keeps each project's sessions, memories and snapshots |
| [`src/sessions-cli.ts`](src/sessions-cli.ts), [`src/export.ts`](src/export.ts) | `jig sessions`: listing a project's sessions, and exporting them as fine-tuning data with secrets blanked out |
| [`src/compact.ts`](src/compact.ts) | Replacing a conversation with the model's summary of it |
| [`src/model.ts`](src/model.ts) | Talks to the API: request settings per provider, streaming, checking streamed tool input, retries |
| [`src/openai.ts`](src/openai.ts) | The OpenAI-compatible API: the conversation as chat messages on the way out, the streamed reply as Messages API blocks on the way in |
| [`src/tools/`](src/tools) | `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `bash`, and `subagent`; grep reads and matches in a worker thread (`grep-worker.ts`); `--check-writes`'s checks (`write-check.ts`) |
| [`src/skills.ts`](src/skills.ts) | Finding skills (the project's, the user's, jig's own), checking them against the specification, the catalog in the system prompt, and the `skill` tool |
| [`src/skill-store.ts`](src/skill-store.ts), [`src/skills-cli.ts`](src/skills-cli.ts) | `jig skills`: installing skills from folders and git repositories, the lockfile, updating and removing |
| [`src/skill-proposals.ts`](src/skill-proposals.ts) | `propose_skill`: a skill the model wrote, checked and shown to the user, saved where they say |
| [`src/skill-evals.ts`](src/skill-evals.ts) | `jig skills test`: a skill's evals, run with and without it, graded by their checks and a model |
| [`src/memory.ts`](src/memory.ts), [`src/memory-cli.ts`](src/memory-cli.ts) | Memory: the files, their index in the system prompt, the `memory` tool, `propose_memory`, and `jig memory` |
| [`src/instructions-proposals.ts`](src/instructions-proposals.ts) | `propose_instructions`: an edit to the project's AGENTS.md, shown as a diff and written if approved |
| [`src/proposals.ts`](src/proposals.ts), [`src/secrets.ts`](src/secrets.ts) | Putting a proposal to the user; what jig refuses to write down because it looks like a secret |
| [`skills/`](skills) | The skills that come with jig: `skill-writer`, which `/skills new` and `/learn` follow |
| [`src/mcp.ts`](src/mcp.ts) | Starting MCP servers and turning their tools into jig tools |
| [`src/hooks.ts`](src/hooks.ts) | Running hooks around tool calls, and before a task ends |
| [`src/permissions.ts`](src/permissions.ts), [`src/settings.ts`](src/settings.ts) | Which tool calls run, need approval, or are refused; allow and deny rules; settings files and project trust |
| [`src/sandbox.ts`](src/sandbox.ts) | The sandbox commands run in: a Seatbelt profile on macOS, bubblewrap's arguments and the keeper that holds the session's PID namespace on Linux; what it keeps read-only in git, and the git changes jig warns of |
| [`src/snapshots.ts`](src/snapshots.ts) | Snapshots of the project's files, and `/undo` |
| [`src/inputs.ts`](src/inputs.ts) | `--keep-inputs`: the files there before a task, watched around its commands, and a copy of one a command lost |
| [`src/prompt.ts`](src/prompt.ts) | System prompt: how to work, facts about the environment, and the project's AGENTS.md |
| [`src/overview.ts`](src/overview.ts) | The overview: the project's files, and those the task names, put before the task |
| [`src/cli.ts`](src/cli.ts) | Arguments, and what is the process's: its title, a task on stdin, its exit code |
| [`src/run.ts`](src/run.ts) | What jig runs, for the CLI and the library: the setup, a task or the interactive session, slash commands, approval and trust prompts, notes to the model, Ctrl+C |
| [`src/lib.ts`](src/lib.ts), [`src/context.ts`](src/context.ts) | jig as a library: `runTask`, and what is a task's own rather than the process's (jig's directory, its commands' environment, who hears its notices) |
| [`src/ui.ts`](src/ui.ts) | Terminal output: streamed text and thinking, tool calls, result previews; and the input, one readline for the session |
| [`src/version.ts`](src/version.ts) | jig's version, read from `package.json` (`--version`, and the MCP client's name) |
| [`src/stats.ts`](src/stats.ts), [`src/prices.ts`](src/prices.ts) | The `--stats` file: model calls, tokens, tool calls and the mechanisms that fired, kept up to date as a task runs; the price table |
| [`src/approvals.ts`](src/approvals.ts) | `--approve-via`: the tool calls jig would ask about at a terminal, asked of a service over HTTP |
| [`src/events.ts`](src/events.ts) | `--events`: a task's start, steps, tool calls, text, notices and end as JSON lines, for a service that runs jig |
| [`server/`](server) | jig as a service ([docs/server.md](docs/server.md)): the task service's HTTP API for many tenants, its store (SQLite, or Postgres for several replicas, through a client of its own in `pg.ts`), a fair scheduler, approvals asked over the API (`approvals.ts`), and the runners that start jig for each task: on this machine, in a Docker container or as a Kubernetes Job, with warm pools of workers started ahead of tasks |
| [`server/gateway.ts`](server/gateway.ts), [`token.ts`](server/token.ts), [`limits.ts`](server/limits.ts), [`state.ts`](server/state.ts), [`redis.ts`](server/redis.ts) | The model gateway for jig behind a backend ([docs/server.md](docs/server.md)): tasks' tokens for the provider's keys, per-tenant limits and quotas, usage and budgets, in memory or in Redis for several replicas, and failover between providers |
| [`server/router.ts`](server/router.ts) | The router in front of several regions ([docs/server.md](docs/server.md)): each tenant's requests to its home region, a task's to the region in its id, new tasks to another region while the home is down |
| [`server/metrics.ts`](server/metrics.ts), [`log.ts`](server/log.ts), [`service-metrics.ts`](server/service-metrics.ts) | What the service, the gateway and the router say about themselves: metrics in Prometheus's text format, and logs as plain lines or JSON (`JIG_LOG_FORMAT=json`); the task service's metrics |
| [`deploy/`](deploy) | The worker and server images, a Docker Compose file for one machine, Kubernetes manifests, and Prometheus, alert and Grafana files |
| [`bench/`](bench) | The benchmark: tasks, runner and report; [`bench/memory/`](bench/memory) and `bench/memory.ts`, the memory benchmark |
| [`eval/`](eval) | Terminal-Bench through Harbor: jig's adapter, the runner, the task samples, the report and its results |

**When does the loop stop?** When a reply has no tool calls (the model's signal that it is done). With
`--check` in a one-shot run (`jig --check "task"`), the first time that happens jig asks the model to check
its work against the task, if a step is left for that, and stops at the next such reply. Also after
`--max-steps` steps, at `--time-limit` seconds (a model call or command still running is stopped, a
question asking you to allow a tool call or to keep a proposal is closed unanswered, and none starts after;
nor do `--check` and `--reviewer` in the last quarter of the time, since what they find might not get
done), on Ctrl+C, and when a safety classifier declines the request. A reply cut off at the output limit
isn't an answer: jig asks the model to continue it, twice at most. Nor is one with no text and no tool call
(empty, or only thinking): it stays out of the history, and the model is asked once to go on. A second such
reply ends the task as `empty` (exit 8), with no answer for `--check`, the reviewer or a Stop hook to
check; one on the last step ends it out of steps (exit 2), and one cut off at the output limit as cut off
(exit 3). A model can also get stuck repeating itself, as milestone 27's trained one did: the same tool
calls with the same results 5 steps in a row stop the task, and a call identical to an earlier one in the
same reply, with only reads between them, isn't run (its result says which call it repeats). A subagent or
a reviewer that stops either way is asked what it found, as at its step limit. At `--max-steps`, jig makes
one more call, in which the model can't call tools, asking what it changed, what it verified and how, and
what is left, and prints the reply: the model's own report, not evidence. Its tokens count in the totals
and in `--stats`. `--no-wrap-up` leaves it out, as the runners in `bench/` and `jig skills test` do, so
that their steps and costs compare with earlier runs. A `Stop` hook can send the model back to work from
its final answer, after `--check` and the reviewer (see Hooks).

The model is told these limits as they near: once half its steps, or half of `--time-limit`, are used, a
note after each step's tool results says how many steps it has used and how much time is left, and, before
its last step, that its next reply is the last whose tool calls run. The note goes in the results' message,
so the cached prefix stays the same; subagents and the reviewer get none. On evolve2, where each task has 4
steps, it took deepseek-flash from 66 of 105 attempts (twice) to 92 of 105 at the same cost (milestone 30).
`--no-budget-notes` leaves the notes out, and `--stats` counts them (`budgetNote`, `budgetNote.lastStep`).

The notes start earlier, once 3 or fewer steps are left, if that comes before half: at evolve2's 4 steps,
after the first step instead of the second (from 6 steps on, half comes first). Each note then also says
what a step is: one reply, whose tool calls all run before the next, in the order given, or at the same
time if none of them runs a command or changes anything. In milestone 30's runs the model heard its budget
only after step 2, and its thinking often guessed that each call was a step, or that a reply's calls might
run out of order, which led some attempts to put a change and its test in different steps. This is on by
default since milestone 31, which measured it with the overview and the test notes (the overview's
paragraph above has the numbers): `--no-early-budget-notes` starts the notes at half again, without saying
what a step is, and `--no-budget-notes` leaves them all out; `--stats` counts the notes it adds
(`budgetNote.early`).

With `--finish-gate`, the first time the model says it is done with a step left, and not in `--time-limit`'s
last quarter, jig looks at what the task's calls did, with no model call, and sends the model back once,
saying what it saw: files changed after the last command that ran something (or with none run at all), or
else a last test run that failed. A command made only of programs that look at files, change them or wait
(`cat`, `grep`, `sed`, `cp`, `git`, `sleep` and the like; a heredoc's lines are a file's, and quoted text an
argument, but for a `$(...)` in double quotes) runs nothing. The file tools' changes count, and so
do the project's files the task changed, by its snapshot, that were last modified after that command ended
(by a later command, or by a job left running in the background). It goes before `--check` and the
reviewer, and is off by default, so a benchmark can measure it; `--stats` counts it (`finishGate`, and
`finishGate.skipped` in that last quarter).

**What if the API stops answering?** jig waits 2 minutes for a reply to start and, once it has started,
5 minutes between one part of it and the next, saying so after a minute; then it asks again, twice at
most, with a notice each time. Keep-alive comments, which DeepSeek sends while it holds a request under
load, aren't parts. `JIG_STREAM_IDLE_MS` sets the 5 minutes, in milliseconds (0: no limit), for a model
that can go longer than that without output.

## Results

What each question came to; the write-ups, with every number's run and caveat, are in
[docs/evaluation.md](docs/evaluation.md) (milestones 1 to 8) and [docs/milestones.md](docs/milestones.md).

| question | how it was measured | what came out |
|----------|---------------------|---------------|
| Does jig work? | the in-house benchmark: 20 tasks, hidden tests, 3 attempts each | 60 of 60 for every version from milestone 7 to 30, on macOS and Linux; in milestone 31, 59 of 60, the failure a 3-second timing test on a loaded machine (lru-cache passed 3 of 3 run alone); no attempt followed a prompt injection |
| Against another agent? | Terminal-Bench 2.0, 20 tasks × 3, against mini-swe-agent on the same model (deepseek-flash) | 68% against 73%: 5 points behind (−3 to +15), within the noise, at 39% lower cost |
| On a real bug, filed after its model was in use? | [Python-Markdown #1651](examples/python-markdown-1651), filed after deepseek-flash was in use; the maintainers' tests hidden; 3 attempts | 3 of 3 solved, $0.13 in all; each fix renders 49,396 generated inputs, three ways each, exactly as upstream's does; one of the three explained why the bug depends on the Python version, and one ran out of steps before its summary |
| Does checking before finishing help? (9) | Terminal-Bench, the 20 tasks and 20 held-out ones | it fixed the failures it aimed at, ran others out of time and solved no more, at 38–65% more cost: opt-in |
| Do skills and memory work? (12, 13) | each with and without, 9 runs each | a skill learned from one session: 9 of 9 against 0 of 9; a convention remembered from an earlier session: 9 of 9 against 0 of 9 |
| Can jig improve its own code? (14–22, 28) | the evolve loop and its referee, on two suites | 19 candidates; one accepted (+15 and +17 points on the suite), then 15 points worse on Terminal-Bench, so not merged; neither advice in the prompt nor changes to the loop moved the suite, and two of the loop's changes never ran at all |
| A stronger model when the tests fail? (23) | the trigger replayed on 676 saved attempts; deepseek-v4-pro alone | the trigger would have reached 1 of 220 failures; v4-pro was 7 points ahead for 5 times the cost, while 2 more steps put flash 24 ahead |
| Does it help to tell the model its budget? (30) | evolve2 at 4 steps, 21 tasks × 5, against two baselines on the same build; run again, at 40 steps, and on the main benchmark | 92 of 105 against 66 and 66, at the same cost, and 92 again; no harm at 40 steps (41 of 42 both ways) or on the main benchmark (60 of 60): on Terminal-Bench no worse (28 of 34 against 29, scored again in milestone 31): on by default. A finish gate and checks after writes never fired: opt-in |
| What did the failures left ask for? (31) | evolve2 at 4 steps, 21 tasks × 5: four changes alone and together, against three baselines; then on by default, at 40 steps, on the main benchmark and on Terminal-Bench | none alone beat the noise; an overview of the project, earlier budget notes and notes on test runs that ran nothing together, with the fourth or without it, passed 290 of 315 against 268 (+7 points, +0.6 to +13.3), and 101 of 105 once on by default; 30% fewer steps at 40; on Terminal-Bench 31 of 36 against 29, at 7% less cost: on by default |
| Why does jig fail Terminal-Bench? (32) | milestone 30's 76 trials, the 17 failures read one by one, each candidate checked by two skeptics | 6 failures weren't the agent's (a refused download, a full disk), which the scorer now leaves out; the rest are mostly beyond the model; `--keep-inputs` gives back a file a command destroyed (opt-in; no harm on evolve2) |
| A second model reviewing the work? (24) | Terminal-Bench, 20 tasks, alternating at each task | 5 points ahead (−20 to +30) for 2.4 times the cost; no result changed because of a review |
| A review that runs the work? (29) | Terminal-Bench, 20 tasks, the hidden tests on each trial's work before the review's fix and after it | in a smoke test, the first failure a review turned into a pass; in the round, no result changed, no false alarm in 9 passes, and the causes of two failures found and lost before they went back |
| Training on its own successes? (26) | a LoRA of Qwen2.5-0.5B on 225 passed sessions, loss on held-out tasks | −57% overall, but −20% on the model's own tokens: the rest is the prompt and the tools learnt by heart |
| Does that make a better agent? (27) | a LoRA of Qwen2.5-7B on 294 passed sessions (an H100 on Modal); jig driving it and the base model on 23 held-out tasks × 3 | the loss fell 30% and the agent got worse: 3% against 9% (−6, −14 to 0); it stopped giving up and started looping |

The numbers in parentheses are milestones. deepseek-flash's failures turned out to be silent: it finishes
sure it is done, its own checks passed or never run, and neither routing to a stronger model nor a
second model's review could see them (milestones 23 and 24); a review that runs the work sometimes can,
but the two in the round that did ran out of time, and what they found didn't go back (milestone 29).
Training a 7B model on its successes taught it their shape, not their judgment (milestone 27).

## How it is measured

- **Hidden tests, and checks of the checks.** Every task's tests are kept from the agent and run after it
  finishes; each task's reference solution must pass and doing nothing must fail, which CI checks.
- **Answers out of reach.** Benchmark runs hide the tasks, the logs and the history from jig's commands
  (one attempt in milestone 14 had found its task's solution on the disk). Terminal-Bench's tests are
  public, so a trial that fetched them counts as failed, whatever it scored.
- **Noise, measured.** Three attempts a task; 95% intervals that resample tasks and their attempts;
  differences paired by task; and runs that are compared made in alternating rounds, so that whatever
  the API does over the hours falls on both.
- **A referee with a known error rate.** Before any candidate ran, how often the referee would accept a
  change that does nothing was measured, against the very runs candidates meet. A candidate must win on
  training tasks and then on held-out ones, and an accepted one goes to Terminal-Bench before a merge.
- **Costs from the tokens.** One price table for every agent, and paid runs only outside DeepSeek's peak
  hours, with a stop when the balance runs low or the API refuses a trial.

## Milestones

Each was measured before the next began. The details are in [docs/milestones.md](docs/milestones.md),
and the design decisions behind them in [docs/design.md](docs/design.md).

| # | milestone | in one line |
|---|-----------|-------------|
| 1 | Core loop | streaming, the file tools and bash, a step limit, approval |
| 2 | Reliability | search, read-before-overwrite, CRLF, edit errors that point at the nearest match; the benchmark |
| 3 | Context | AGENTS.md, compaction, saved sessions |
| 4 | Safety | the macOS sandbox, plan mode, allow and deny rules, snapshots and `/undo` |
| 5 | Extensions | Agent Skills, MCP, hooks, subagents, parallel reads, project trust |
| 6 | Evaluation | Terminal-Bench 2.0 through Harbor, against mini-swe-agent on the same model |
| 7 | Linux and CI | bubblewrap on Linux with the same policy, and CI on Linux and macOS |
| 8 | npm package and error bars | `jig-agent`, and three attempts a task with 95% intervals |
| 9 | Checking before finishing | `--check`: fixed what it aimed at, solved no more overall, so opt-in |
| 10 | What mini-swe-agent's lead was made of | look-ups of the answers, counted as failures, cut the lead from 12 points to 5, within the noise |
| 11 | One model, two APIs | an OpenAI-compatible API, translated at the edge; no difference between DeepSeek's two endpoints |
| 12 | Skills to install, write and measure | `jig skills`; a learned skill: 9 of 9 against 0 of 9 |
| 13 | Memory and context | memories and AGENTS.md edits, proposed and approved; 9 of 9 against 0 of 9 |
| 14 | jig changes itself, under a referee | the evolve loop: analysis, candidates in a copy, a calibrated referee |
| 15 | A suite that can tell a fix from luck | evolve2: hard enough only at a budget of 4 steps |
| 16 | The first change the referee accepted | +15 and +17 points, after the comparison was fixed |
| 17 | The accepted change, on Terminal-Bench | 15 points worse, so not merged |
| 18 | The answers out of reach | hidden paths for every benchmark run; a cheaper check that didn't agree with Terminal-Bench |
| 19 | Terminal-Bench as the last stage | `tbcheck`, run only outside peak hours |
| 20 | A second round, against fresh baselines | three candidates, all rejected: two beat the training half and lost on the held-out one |
| 21 | New causes, from today's jig | advice in the prompt doesn't move the suite |
| 22 | The loop and the tools, not the prompt | closer (+8, +5), still short of the bar |
| 23 | Routing to a stronger model | `--escalate`; the trigger can't see flash's failures, and more steps beat a stronger model |
| 24 | A second model reviews the work | `--reviewer`; no result changed because of a review |
| 25 | The key stays on the host | a proxy, so Terminal-Bench's containers hold only a token |
| 26 | A training set from jig's own successes | `bench/dataset.ts`, and a LoRA smoke test on this Mac |
| 27 | A 7B model trained on jig's successes | a LoRA on Modal, served next to the base model: the loss fell, the agent got worse |
| 28 | The loop and the tools again | three candidates, all rejected; two never ran, and a step's narrowed tools were no limit (now they are, and an invalid call goes back in part) |
| 29 | A reviewer that runs the work | `jig review`, in a copy of the machine; one failure turned into a pass, in a smoke test; in the round, no result changed |
| 30 | Four ideas from other agents, measured | budget notes on by default (+25 points at 4 steps, twice); a finish gate, checks after writes and tolerant edits stay opt-in |
| 31 | What the failures left asked for, measured | the overview, earlier budget notes and test notes on by default (+7 points at 4 steps, in three runs); letting `write_file` trust what a result showed was left out |
| 32 | Terminal-Bench's failures, read | a scorer that leaves out trials nobody could pass, and `--keep-inputs` |

## Tests

```bash
npm test            # the tools, permissions, sandbox, snapshots, search, context, skills, memory, MCP
                    # (against a hand-written server), hooks, subagents, running headless (--add-dir,
                    # --stats, a hung API, a session piped in), the prompt (pastes, history, Ctrl+C),
                    # benchmark metrics, the evolve referee and the copies candidates work in, exporting
                    # sessions, and the loop: no API calls
npm run typecheck
```

[CI](.github/workflows/ci.yml) runs both on Linux and macOS with Node 22 and 24, the sandbox tests included
(on Linux it installs bubblewrap and lifts Ubuntu's AppArmor limit on user namespaces), and checks the
benchmark's tasks with the oracle and noop agents, which needs no API key, and packs, installs and runs the
npm package, and imports `runTask` from it. The Linux setup was tried locally in Debian containers as an
ordinary user, with Node 22 and 24, before it went in.

## Releasing

The npm package is `jig-agent`. Node won't strip types from files under `node_modules`, so the package
ships JavaScript: `npm pack` and `npm publish` first compile `src/` into `dist/` (`tsconfig.build.json`),
and the package holds only `dist/`, `skills/` (jig's own skills), the README and the license. To release,
bump the version with `npm version <patch|minor|major>`, then `npm publish` from an npm account; CI's
`package` job packs, installs and runs the tarball on every push.

## License

MIT, see [LICENSE](LICENSE).
