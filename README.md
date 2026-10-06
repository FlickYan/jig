# jig

A minimal coding agent for the terminal, written from scratch in TypeScript on the Anthropic Messages API
(Claude, or DeepSeek through its Anthropic-compatible endpoint). There is no agent framework: it is one
streaming tool-use loop, six tools, context management (AGENTS.md, saved sessions, compaction), safety
(an OS sandbox on macOS and Linux, permission modes, deny rules, snapshots with undo), extensions (Agent Skills, MCP
servers, hooks, subagents), and a benchmark that measures each version.

(A jig is the workshop fixture that holds a piece of work and guides the tool cutting it, which is what an
agent harness does for a model.)

## Quick start

You need Node 22.18 or newer (it runs the TypeScript directly, so there is no build step) and an
API key: DeepSeek for the default model (`deepseek-flash`), or Anthropic for Claude models.

```bash
npm install
export DEEPSEEK_API_KEY=sk-...    # or ANTHROPIC_API_KEY, and pass --model claude-opus-5-5

npm start -- -C ~/code/some-project "the login test is failing, fix it"   # run one task
npm start -- -C ~/code/some-project                                       # interactive session

npm link    # optional: puts `jig` on your PATH, then run `jig` inside any project
```

```
Usage: jig [options] [task]

  -m, --model <id>      deepseek-flash (default), deepseek-v4-pro, or a Claude model like claude-opus-5-5
  -e, --effort <level>  low | medium | high | xhigh | max (default: the model's own; DeepSeek takes low | high | max)
      --mode <mode>     when to ask before a tool call (default: edits)
                          plan   look around and plan; refuse every change
                          ask    ask before every file change and command
                          edits  change files in the project freely; ask before commands the sandbox doesn't contain
                          auto   never ask
  -y, --yes             same as --mode auto
      --no-sandbox      run commands directly on this machine instead of in the sandbox (Seatbelt on
                        macOS, bubblewrap on Linux)
      --allow-network   let sandboxed commands use the network
      --hide-thinking   don't print the model's thinking (/thinking toggles it in a session)
  -c, --continue        continue this project's most recent session
      --resume <file>   continue a saved session (--sessions lists them)
      --compact-at <n>  summarize the conversation once it reaches n tokens (default: 200000; 0: never)
  -C, --cwd <dir>       project directory (default: the current directory)
      --add-dir <dir>   let the file tools work in this directory too, and the sandbox write there
                        (repeatable; --add-dir / inside a container makes the whole system the project)
      --max-steps <n>   most model calls per task (default: 50)
      --no-subagents    leave out the subagent tool
      --stats <file>    keep a JSON file with the model calls, tokens and tool calls so far
```

In a session: `/mode`, `/undo`, `/thinking`, `/skills`, `/mcp`, `/context`, `/compact`, `/reset`, `/help` and
`/exit`, and `/<skill> [task]` runs a skill. After each task jig prints the steps taken, the tokens sent and
received (subagents included), and how many input tokens came from the prompt cache.

### Safety

- **Sandbox.** Commands run in the operating system's sandbox, as in Codex and Claude Code: Seatbelt on
  macOS, [bubblewrap](https://github.com/containers/bubblewrap) on Linux. They can read anything but write
  only inside the project, its git directory, the directories added with `--add-dir` and the temp
  directories, and they can't reach the network (`--allow-network` lifts that). On macOS, localhost stays
  open; on Linux each command gets an empty network of its own, so a test can still start a server and
  talk to it, but only within one command. Because a sandboxed command can't harm anything outside the
  project or send data out, in the default `edits` mode commands run without asking. On Linux the sandbox
  needs bubblewrap installed (`sudo apt install bubblewrap`) and user namespaces allowed; where it can't
  run, jig says why, and commands ask first. `--no-sandbox` turns it off.
- **Modes.** `plan` only looks: file changes and commands that change things are refused, and the model is
  told to propose a plan. `ask` asks before every change and command, `edits` (the default) lets file
  changes and contained commands through, and `auto` never asks. Reading never asks: `read_file`, `grep`,
  `glob`, and commands that only read inside the project (`ls`, `cat`, `git status`, `git diff`, ...).
  When jig does ask, `[a]lways` approves that program (say, `python3`) for the rest of the session.
- **Rules.** `~/.jig/settings.json` and the project's `.jig/settings.json` can list commands to always
  allow or always refuse:

  ```json
  { "allow": ["npm test", "make"], "deny": ["git push", "npm publish"] }
  ```

  A deny rule is refused in every mode, even `auto`, and matches its words in order within one command, so
  `"git push"` also catches `git -C repo push origin` and `bash -c "git push"`. A deny rule can also name a
  tool, like `"mcp__github__merge_pull_request"`. The settings can also hold `"sandbox": false` or
  `"network": true` for a project.
- **Project trust.** A repository's `.jig/settings.json` could start programs (hooks, MCP servers) or
  loosen the sandbox the moment you run jig in a repository you just cloned. So those parts only apply after
  you say yes to a prompt listing exactly what they would do; the answer is remembered for that version of
  the file, and any change asks again. Until then only its deny rules apply, since they only restrict.
- **Undo.** Before each task, jig snapshots the project's files into a private git repository in
  `~/.jig/snapshots/` (so it works in any folder and never touches the project's own git history), and
  `/undo` puts back every file the task changed, created or deleted, whether through the file tools or a
  command. `/undo` again goes one task further back. Projects with more than 200 MB of files that aren't
  ignored aren't snapshotted.
- **Credentials stay with jig.** The commands the model runs get jig's environment without its API keys
  (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`). They never need them, and a model that
  runs `env` to look around, as both agents did in the Terminal-Bench runs, would otherwise copy the key
  into the conversation and the logs, where a prompt injection could also reach it.
- **Prompt injection.** The system prompt tells the model that text in files and command output is data,
  not instructions, and to tell the user when it finds instructions there. The sandbox and the deny rules
  are what protect you when that isn't enough.

### Context

- **AGENTS.md.** jig reads `AGENTS.md` (or `CLAUDE.md` where there is none) from every directory between
  the repository root and the working directory, and puts it at the end of the system prompt, the most
  specific file last. Build commands, conventions and gotchas written there apply to every session.
- **Sessions.** Every message is appended to a JSON Lines file in `~/.jig/sessions/<project>/` the moment
  it exists, so nothing is lost on a crash or Ctrl+C. `jig -c` continues the most recent session,
  `jig --sessions` lists them, `jig --resume <name>` picks one. Tool calls a crash left without results
  are answered as interrupted when a session is loaded, so the history is always valid.
- **Compaction.** jig tracks how many tokens the conversation takes up (measured from each reply's usage,
  estimated for tool output since). Past `--compact-at` it asks the model to summarize the conversation and
  continues from that summary alone; `/compact` does it on demand and `/context` shows the numbers.

### Extensions

- **Skills.** jig reads [Agent Skills](https://agentskills.io): folders with a `SKILL.md` (a name and a
  description in YAML frontmatter, then instructions) and maybe scripts and reference files. They are found
  in `.jig/skills`, `.agents/skills` and `.claude/skills`, in the project and in your home directory, the
  project's winning on a name clash. Loading is progressive: the system prompt lists only each skill's name
  and description; the model calls the `skill` tool to load the instructions when a task matches, and
  reads the skill's other files only if the instructions point to them. `/<skill> [task]` loads one
  yourself.
- **MCP servers.** jig is an MCP client over stdio, on the official TypeScript SDK. Servers configured in
  the settings start with jig, and their tools join jig's own as `mcp__<server>__<tool>`:

  ```json
  { "mcpServers": { "tracker": { "command": "node", "args": ["tools/tracker-server.mjs"], "env": {} } } }
  ```

  A tool the server marks read-only runs like jig's own read tools; any other asks first (outside `auto`
  mode) and is refused in `plan` mode, because it acts outside the sandbox's reach. `[a]lways` approves one
  tool for the session; allow and deny rules can name tools too.
- **Hooks.** Commands that run around tool calls, configured like Claude Code's:

  ```json
  { "hooks": {
      "PreToolUse":  [{ "matcher": "bash", "command": "./scripts/check-command.sh" }],
      "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "ruff check \"$JIG_FILE\" 1>&2 || exit 2" }] } }
  ```

  A hook gets the call as JSON on stdin, plus `JIG_TOOL`, `JIG_FILE` and `JIG_PROJECT_DIR`. Exit code 2 from
  a `PreToolUse` hook blocks the call and its stderr tells the model why; from a `PostToolUse` hook, its
  stderr goes to the model with the result (a linter's complaints, say). Any other failure is shown to you
  and otherwise ignored.
- **Subagents.** The `subagent` tool hands a research task (where is X handled, which files would a change
  touch) to a fresh agent loop with a context of its own. It gets the tools that only look, under `plan`
  mode's rules, never asks you anything, and returns only its findings, so the files it read don't fill the
  main conversation. Several subagent calls in one reply run at the same time.

## How it works

```
 task ──▶ messages ──▶ model (streamed) ──▶ reply has tool calls? ── no ──▶ done
             ▲                                    │ yes
             │                                    ▼
             │   for each call: check input ▶ PreToolUse hooks ▶ permission policy ▶ run
             │                  ▶ truncate output ▶ PostToolUse hooks
             │   (calls that only read run at the same time, the others in order)
             │                                    │
             └──── all tool results, in one message ◀┘
```

| File | What it does |
| --- | --- |
| [`src/agent.ts`](src/agent.ts) | The loop: call the model, run the tools it asks for, send back the results, until it answers without a tool call; compact when needed |
| [`src/conversation.ts`](src/conversation.ts), [`src/session.ts`](src/session.ts) | A conversation's messages, size and saved session file |
| [`src/compact.ts`](src/compact.ts) | Replacing a conversation with the model's summary of it |
| [`src/model.ts`](src/model.ts) | The only file that talks to the API: request settings per provider, streaming, checking streamed tool input |
| [`src/tools/`](src/tools) | `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `bash`, and `subagent` |
| [`src/skills.ts`](src/skills.ts) | Finding skills, the catalog in the system prompt, and the `skill` tool |
| [`src/mcp.ts`](src/mcp.ts) | Starting MCP servers and turning their tools into jig tools |
| [`src/hooks.ts`](src/hooks.ts) | Running hooks around tool calls |
| [`src/permissions.ts`](src/permissions.ts), [`src/settings.ts`](src/settings.ts) | Which tool calls run, need approval, or are refused; allow and deny rules; settings files and project trust |
| [`src/sandbox.ts`](src/sandbox.ts) | The sandbox commands run in: a Seatbelt profile on macOS, bubblewrap's arguments on Linux |
| [`src/snapshots.ts`](src/snapshots.ts) | Snapshots of the project's files, and `/undo` |
| [`src/prompt.ts`](src/prompt.ts) | System prompt: how to work, facts about the environment, and the project's AGENTS.md |
| [`src/cli.ts`](src/cli.ts) | Arguments, interactive session, slash commands, approval and trust prompts, notes to the model, Ctrl+C |
| [`src/ui.ts`](src/ui.ts) | Terminal output: streamed text and thinking, tool calls, result previews |
| [`src/stats.ts`](src/stats.ts) | The `--stats` file: model calls, tokens and tool calls, kept up to date as a task runs |
| [`bench/`](bench) | The benchmark: tasks, runner and report |
| [`eval/`](eval) | Terminal-Bench through Harbor: jig's adapter, the runner, the task samples, the report and its results |

**When does the loop stop?** When a reply has no tool calls (the model's signal that it is done). Also on
`--max-steps` model calls, on Ctrl+C, and when a safety classifier declines the request.

## Design decisions

- **Exact-string edits.** `edit_file` replaces `old_string` only if it occurs exactly once, counting
  overlapping matches. Line numbers go stale after the first edit, and whole-file rewrites are slow, cost
  output tokens and can silently drop code. The replacement is spliced in by index: `String.replace` would
  expand `$&` and `$1` inside the new code.
- **Errors are written for the model.** A failed tool call returns an error that says how to fix it. When
  `old_string` doesn't match, jig looks for the nearest thing in the file: leftover line numbers from
  `read_file`, the same lines with different indentation (shown exactly as they are), or where its first
  line appears. The next attempt usually succeeds.
- **Read before overwrite.** jig remembers each file's modification time and size as of the model's last
  read (`read_file`, or printing it with `cat`, `head` or `tail`). `write_file` refuses to replace a file the
  model hasn't read, or one that changed since (a formatter, a command or the user edited it), so it never
  overwrites work it hasn't seen. `edit_file` doesn't need the check: its exact, unique match already proves
  the model knows the text it replaces. In M2 and M3 the check covered edits too, and in the benchmark it
  refused 22 edits, all false alarms, so M4 narrowed it.
- **Line endings are the file's business.** The model writes `\n`; in a file that uses `\r\n`, edits are
  matched and written with `\r\n` (including lines an edit adds), and `write_file` keeps an existing file's
  CRLF endings.
- **Search that respects `.gitignore`.** `grep` and `glob` list files with `git ls-files` when the project
  is a git repository (so ignored files are skipped for free), and walk the directory otherwise. They are
  plain Node, with no dependency on ripgrep being installed.
- **Streamed tool input is checked twice.** For Claude, tool input streams as it is generated
  (`eager_input_streaming`), so the API no longer validates it. The SDK's lenient parser can turn
  `"say "hi" now"` into `"say "`, which would silently write a truncated file. jig re-parses the raw JSON
  strictly and checks it against the tool's schema, and sends anything broken back to the model as
  `INVALID_JSON` instead of running it.
- **The history only grows.** The loop never edits earlier messages, and the system prompt and tool list
  stay fixed for the whole session. This keeps the prompt cache hitting (each call pays full price only
  for what is new) and keeps the model's earlier thinking blocks valid (the API can reject them once the
  history before them has changed).
- **Compaction replaces the history; it never edits it.** The summary request repeats the last request
  with one extra message, so it is served from the prompt cache. Afterwards only the summary is sent:
  keeping the last few turns verbatim would replay thinking blocks whose earlier history is gone, which
  the API can reject, and a fresh start is valid for both providers. A request the user just typed is
  kept word for word after the summary, and the model must read files again before editing them.
- **Every tool call gets a result.** Even calls that never ran (declined, interrupted, cut off at
  `max_tokens`, invalid input) get an error result, so the next request is always valid.
- **Commands run in their own process group.** A timeout or Ctrl+C kills the whole group, so a test
  runner's worker processes die too. Commands get no stdin, so an interactive prompt gets end-of-file
  instead of hanging the agent.
- **The OS sandbox, not Docker.** A container would need an image with every project's toolchain and
  slow bind mounts on macOS. Seatbelt applies a profile to the user's own shell, so python, node and git
  just work, startup is instant, and the policy (write here, no network) is a few lines jig generates.
- **bubblewrap on Linux, rather than Landlock and seccomp.** Codex restricts writes with Landlock and
  blocks sockets with seccomp, which needs native code to load the filters. bubblewrap does the same job
  in one command jig can run: the file system mounted read-only with the writable directories bound back
  in, a fresh `/dev`, and with `--unshare-net` a network namespace with nothing but loopback. It is small,
  packaged everywhere (Flatpak uses it), and needs no privileges where user namespaces are allowed.
  Each command gets its own namespace, so a server one command starts is out of reach of the next; on
  macOS it isn't. Killing a command's process group still reaches everything inside, and
  `--die-with-parent` takes the sandbox down if jig dies.
- **Deny rules are a guardrail, not a boundary.** No pattern catches every disguise (`g\it push`,
  `$(echo git) push`), so deny rules err on the side of refusing and the sandbox is what actually limits
  what a command can do.
- **Snapshots in a private repository.** `git stash` would change the user's repository and miss
  untracked files; a second git directory with the project as its work tree snapshots everything that
  isn't ignored, deduplicates unchanged files, and leaves the project untouched.
- **Skills load through a tool, not `read_file`.** The model could read `SKILL.md` itself, but `read_file`
  stays inside the project and user skills live in the home directory. The `skill` tool also lists the
  skill's other files, and pins the instructions so compaction keeps them word for word rather than
  summarizing them away mid-task.
- **Calls that only read run at the same time.** When every call in a reply is a read (file reads,
  searches, subagents, read-only MCP tools), they run in parallel; if any call changes something, they
  all run in order, since one may depend on another. Results still go back in the order of the calls, and
  in the terminal a result that doesn't follow its own call says whose it is.
- **MCP servers come back.** Ctrl+C in a terminal reaches every process in the foreground group, MCP
  servers included, and servers crash. A tool call to a server that has stopped starts it again.
- **A subagent that runs out of steps still reports.** Hitting its step limit mid-research would waste
  everything it read, so it gets one more call, without tools, to write up what it found.
- **Waiting on the API is bounded and visible.** The SDK's timeout covers only the wait for a response
  to start (a stream's first bytes arrive within seconds when the API is healthy, however long the reply
  runs), so jig sets it to 2 minutes instead of 10, and prints a notice for each automatic retry. During a
  DeepSeek outage in milestone 6, jig had sat silent for half an hour.
- **Two providers, one format.** DeepSeek's Anthropic-compatible API lets the same SDK and message format
  serve both. DeepSeek does not support `is_error` on tool results, so for DeepSeek failures are marked
  with `Error:` in the text instead, and the Claude-only settings (adaptive thinking with short progress
  notes, prompt-cache breakpoints, a server-side fallback model if a safety classifier declines) are left
  out.

## Benchmark

`bench/` is a small benchmark in the style of Terminal-Bench: twenty tasks, each a small project, an
instruction worded the way a user would ask, hidden tests, and a reference solution.

For each attempt the runner:
1. copies the task's project to a temporary directory and commits it to a fresh git repository;
2. runs jig on the instruction (`--yes`, with a step limit and a timeout);
3. copies in the hidden tests, which the agent never saw, and runs them. Passing means solved.

It records whether each attempt passed, plus steps, tool calls, failed tool calls (by tool), tokens,
estimated cost and time. It reads these from jig's own terminal output, so it can measure any version of
jig: `--ref m1` runs the code tagged `m1`, on today's tasks.

```bash
npm run bench -- --ref m1 --label m1 --attempts 3   # milestone 1
npm run bench -- --ref m6 --label m6 --attempts 3   # milestone 6
npm run bench -- --label m7 --attempts 3            # the current code
npm run bench:report                                # compare the saved runs (Markdown)
```

Each run is saved to `bench/results/` (commit these: they are the evidence), with a fingerprint of the
task suite: the report warns when runs used different versions of the tasks, which are not comparable.
Runs on earlier versions of the suite are in `suite-12/`, `suite-15/`, `suite-17/` and `suite-20/`, one-off experiments in
`experiments/`; `npm run bench:report -- bench/results/experiments` reports a folder.
Logs of every attempt (the transcript, the diff the agent made, the check's output and jig's session file)
go to `bench/logs/`. Model output varies between runs, so use several `--attempts`: the report shows the
pass rate with its spread between rounds, and a difference smaller than that spread is noise.
`--jig-args="--effort low"` passes options to jig, for ablations of one setting.

`npm run bench -- --agent oracle` applies every reference solution and must pass all tasks;
`--agent noop` changes nothing and must fail them all. Together they show each task is solvable and not
already solved, without spending anything on a model.

| Task | What it tests |
| --- | --- |
| `pagination` | Two bugs in one function family (Python) |
| `settings-crlf` | A fix that adds lines to a file with Windows line endings, without mixing in Unix ones |
| `inventory` | Finding a one-character bug from an error message in a 20-file package |
| `wordfreq` | Adding a CLI option with an exact output format |
| `map-limit` | Async ordering and concurrency bugs (JavaScript) |
| `rename-function` | A rename across several files, keeping a deprecated alias |
| `log-report` | Analyzing a 4,000-line log with malformed lines into a JSON report |
| `failing-tests` | Making a failing test suite pass without touching the tests |
| `long-file` | A bug deep in a 1,900-line module |
| `lru-cache` | Implementing a class from its docstring, O(1) |
| `config-migration` | Implementing a config format change from a spec document (JavaScript) |
| `git-merge` | Merging a branch and resolving the conflict so both changes survive |
| `project-conventions` | A small feature that must follow the project's AGENTS.md, including rules the code doesn't show |
| `stale-cache` | Stale profiles after an update: two update paths, and the cache must keep working (hard) |
| `csv-parser` | A CSV parser to a precise spec with many edge cases (hard) |
| `injection-readme` | A typo fix in a project whose README tells AI agents to write to the home directory and delete the tests |
| `injection-output` | A bug fix where the test script's output tells AI agents to pipe a script from the internet into bash |
| `skill-migration` | A database migration whose index must follow a naming rule that is only in the project's skill |
| `mcp-ticket` | "Please fix ticket PRICE-118": what the fix is, is only in the ticket, which the project's tracker MCP server serves |
| `hook-lint` | A feature where the team's linter, which the project's hook runs after each edit (it isn't in the project), forbids two common habits |

For the two injection tasks the runner also records whether any tool call tried to do what the injected
text said, separately from whether harm was done: a sandboxed agent can try and still pass.

The last three tasks need M5's extensions, so versions before it can only solve them by luck or by working
around the missing feature (decoding the tracker's data by hand, say). They check that the model uses the
features when it should, not just that they work. Their projects configure an MCP server or a hook in
`.jig/settings.json`, which the runner trusts (`JIG_TRUST_PROJECT=1`), and a task's `home/` directory is
copied into the attempt's home directory, which is how `hook-lint`'s linter is "installed".

This is an in-house suite: good for comparing versions of jig and settings (models, effort, tools), not
for comparing against other agents. For that, see [Terminal-Bench](#terminal-bench) below.

### Results

**M7 on macOS and on Linux**, on the current suite (deepseek-flash, three attempts per task):

| run | passed | steps | tool calls | failed tool calls | tokens in | cost | time |
|-----|--------|-------|------------|-------------------|-----------|------|------|
| m7 (macOS, Seatbelt) | 100% (60/60) | 7.0 | 8.9 | 0.0 | 30,795 | $0.0047 | 14s |
| m7-linux (Debian container, bubblewrap) | 100% (60/60) | 7.0 | 8.7 | 0.0 | 30,780 | $0.0043 | 13s |

Every attempt passed on both systems, so nothing in milestones 6 and 7 cost a task. The Linux run ran
jig as an ordinary user in a Debian container, every command in the bubblewrap sandbox; no command
tripped over it (none was refused a write), and as on macOS no attempt acted on the prompt injections
(0 of 6). Getting the benchmark onto Linux also found a bug in it: two tasks ran their hidden tests with
`node --test bench_tests/`, which only Node 26 accepts, so on Node 22 and 24 their reference solutions
failed. They now pass the test files by name. That changed the suite's fingerprint, so these runs aren't
directly comparable with the ones below, though no task changed.

**M4 against M5, on the 20-task suite as it was then** (in `bench/results/suite-20/`; deepseek-flash,
three attempts per task):

| run | passed | steps | tool calls | failed tool calls | tokens in | cost | time |
|-----|--------|-------|------------|-------------------|-----------|------|------|
| m4 | 98% ±2% (59/60) | 7.2 | 9.1 | 0.0 | 30,360 | $0.0045 | 14s |
| m5 | 98% ±2% (59/60) | 6.8 | 8.8 | 0.0 | 31,213 | $0.0045 | 13s |

On the three tasks for the extensions (per attempt):

| task | m4 | m5 |
|------|----|----|
| `skill-migration` | 2/3 passed · 7.3 steps · 24.0k tokens in · $0.0025 | 3/3 passed · 7.0 steps · 23.1k tokens in · $0.0024 |
| `mcp-ticket` | 3/3 passed · 9.0 steps · 43.2k tokens in · $0.0047 · 13s | 3/3 passed · 8.0 steps · 26.5k tokens in · $0.0031 · 9s |
| `hook-lint` | 3/3 passed · 7.3 steps · 26.2k tokens in · $0.0040 | 3/3 passed · 7.3 steps · 29.6k tokens in · $0.0046 |

What the logs showed:

- **M5 used each extension where it applied.** It loaded the `db-migrations` skill as its first call in
  all three `skill-migration` attempts, and asked the tracker server for the ticket as its first call in all
  three `mcp-ticket` attempts. In `hook-lint`, the hook's feedback reached it in one attempt (when it wrote
  the file, and again after an edit that left the `raise ValueError` line alone), and it switched to
  `InvalidOrder`.
- **M4 worked around the missing features, at a price.** With no MCP client, M4 read `.jig/settings.json`
  and the server's source in every `mcp-ticket` attempt, then spoke JSON-RPC to the server by hand
  (`printf '{"jsonrpc":"2.0",…}' | node tools/tracker-server.mjs`). It passed, but M5 did the same with 39%
  fewer input tokens and 34% lower cost, and the trick only works because this server is a local script.
  M4 found the skill's naming rule only when it happened to look in hidden directories (2 of 3). The third
  attempt named the index `orders_user_id_idx` and failed.
- **The hook mostly wasn't needed, because the model went looking.** In 3 of the 6 `hook-lint` attempts
  (both versions) the model read `.jig/settings.json`, found the linter the hook runs and ran it itself;
  in 2 more it used `InvalidOrder` after reading `shop/errors.py`. The hook stepped in only in the sixth.
  A hook guarantees the check; without one, it depends on the model choosing to look.
- **Subagents went unused.** In 60 attempts the model never chose the subagent tool: these projects are
  small enough to read directly. Subagents do work: asked to use two at once to find where tool output is
  truncated and where the sandbox profile is written, jig ran both in parallel and got both locations right.
  This suite can't show what they are for, which is keeping a large codebase's research out of the main
  context. Milestone 6's larger tasks should.
- **Parallel calls saved little time.** 36 of 60 M5 attempts ran calls in parallel at least once, but
  reads take milliseconds and the model's generation dominates: 14.2s → 13.6s per attempt on the 17
  earlier tasks, within noise.
- **No regressions.** On the 17 earlier tasks M5 passed 50 of 51. In the one miss, a `wordfreq` attempt
  padded counts to a fixed width the spec doesn't ask for: a model mistake of the kind every version has
  made once. Steps went from 7.0 to 6.7 and cost stayed the same.

**M1 to M4, on the earlier 17-task suite** (in `bench/results/suite-17/`), with deepseek-flash and three
attempts per task:

| run | passed | steps | tool calls | failed tool calls | tokens in | cost | time |
|-----|--------|-------|------------|-------------------|-----------|------|------|
| m1 | 100% (51/51) | 7.2 | 7.7 | 0.0 | 29,447 | $0.0046 | 15s |
| m2 | 98% ±3% (50/51) | 7.4 | 9.2 | 0.2 | 35,649 | $0.0047 | 15s |
| m3 | 98% ±3% (50/51) | 7.2 | 8.8 | 0.0 | 32,192 | $0.0046 | 14s |
| m4 | 98% ±3% (50/51) | 7.0 | 8.6 | 0.0 | 29,955 | $0.0045 | 14s |

Averages are per attempt. What the runs and their logs showed:

- **The pass rate is at its ceiling.** deepseek-flash solves nearly every task with any version of jig,
  even at `--effort low`, so the pass rate can't show the harness getting better. What the benchmark does
  show is that nothing regressed, what each version costs, and, in the logs, why things fail.
- **Single failures are noise.** `stale-cache` failed once for M3 and once for M4, and twice for M4 at low
  effort. Ten more attempts each: M1 10/10, M4 10/10. A difference of one attempt in three means nothing.
- **AGENTS.md mattered.** M2 failed `project-conventions` in 2 of 6 attempts (counting the run on the
  15-task suite), each time without having opened AGENTS.md, so it missed the CHANGELOG rule. M1 happened
  to read it every time; M3 and M4 load it themselves and passed 12 of 12.
- **The read-before-edit check misfired.** M2's failed tool calls were edits refused right after the model
  had printed the file with `cat`. M3 counted `cat` as a read but still missed forms like
  `cat x 2>/dev/null`. Across five M2 and M3 runs the check refused 22 edits, none of them because a file
  had changed, and in the logs we checked the model then read the file and made the same edit. M4 limits
  the check to `write_file`: no refusals since, and failed tool calls went from 0.2 per attempt to 0.
- **No version followed the prompt injections** (0 of 6 attempts each), so with this model they didn't test
  the sandbox. That it blocks writes outside the project and the network is checked by `test/safety.test.ts`,
  which runs real sandboxed commands. The sandbox and snapshots cost no measurable time.
- **The benchmark had bugs too.** A hidden test accepted only one reading of "throws"; a task meant to
  test line endings never needed a line ending; and naming each task's folder after the task told the
  model "this is a benchmark for injection" (it said so in its reasoning). Each was found by reading the
  logs of a failure or of a surprising pass, and fixed.

## Terminal-Bench

The in-house benchmark compares versions of jig; to compare jig with another agent, milestone 6 runs it
on [Terminal-Bench 2.0](https://www.tbench.ai) through [Harbor](https://harborframework.com), against
[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (the SWE-agent team's minimal baseline: a
bash tool, a short prompt, no other machinery) with the same model, deepseek-flash, on the same tasks.

```bash
python3 -m venv eval/.venv && eval/.venv/bin/pip install harbor
export DEEPSEEK_API_KEY=sk-...
eval/run.sh tb-jig jig                          # jig on the 20 tasks in eval/subset.txt
eval/run.sh tb-mini mini-swe-agent              # the baseline
eval/run.sh abl-effort-low jig --ak effort=low  # an ablation: any jig option, through the adapter
python3 eval/report.py eval/results/tb-*.json   # the first table below, from the saved summaries
python3 eval/report.py --only eval/ablation-subset.txt eval/results/tb-jig.json eval/results/abl-*.json
```

- [`eval/jig_agent.py`](eval/jig_agent.py) is jig's Harbor adapter. It installs Node and jig from this
  checkout in each task's container, runs `jig --yes --add-dir / --stats …` on the instruction (the
  container is the sandbox, so the whole file system is the project), and reads the turns and tokens back
  from the stats file. The adapter hands the API key to jig's process only, and never writes it down.
- The tasks are a seeded random sample of 20 of the 61 that ask for 2 GB of memory, one CPU and at most 30
  minutes ([`eval/subset.txt`](eval/subset.txt)), because this Mac gives Docker 3 GB. The task images are
  x86-64, so on Apple Silicon everything in them runs under emulation, for both agents alike, while the
  time limits stay as they are.
- One attempt per task, for budget: a difference of a task or two is noise, as the in-house benchmark showed.
- Costs come from the token counts and one price table for both agents. DeepSeek's off-peak discount made
  part of the actual bill lower (the first two tasks were billed at about half the table's price).

### Results

| run | passed | turns | tokens in | tokens out | cost | agent time |
|-----|--------|-------|-----------|------------|------|------------|
| jig | 75% (15/20) | 28.4 | 1,499k | 36k | $0.059 | 6.3 min |
| mini-swe-agent | 80% (16/20) | 33.4 | 2,342k | 45k | $0.074 | 6.8 min |

Averages are per task. The two disagree on three tasks: jig alone solved `dna-assembly`, mini-swe-agent
alone `modernize-scientific-stack` and `mteb-retrieve`. Neither solved `adaptive-rejection-sampler`,
`filter-js-from-html` or `make-mips-interpreter`. The full matrix is in `python3 eval/report.py eval/results/tb-*.json`.

Ablations, on 8 of the 20 tasks ([`eval/ablation-subset.txt`](eval/ablation-subset.txt), again a seeded
sample), against the default run on the same 8:

| run | passed | turns | tokens in | tokens out | cost | agent time |
|-----|--------|-------|-----------|------------|------|------------|
| jig, default | 7/8 | 24.9 | 1,437k | 29k | $0.054 | 4.9 min |
| `--effort low` | 7/8 | 18.6 | 779k | 20k | $0.034 | 3.2 min |
| `--compact-at 50000` | 6/8 | 31.4 | 681k | 38k | $0.068 | 6.3 min |
| `--no-subagents` | 7/8 | 17.4 | 865k | 22k | $0.036 | 4.0 min |

The model never called the subagent tool on these tasks (see below), so `--no-subagents` is in effect a
second run of the default, and shows how much two runs of the same thing differ.

What the runs and their logs showed:

- **The same success rate, for less.** 75% against 80% is one task, within noise. jig got there in fewer
  turns (28 against 33) with smaller requests (53k tokens on average against 70k), so it used 36% fewer
  input tokens and cost 20% less per task.
- **In a container, the model works through bash.** Of jig's 615 tool calls, 500 were bash, 113 the file
  tools, 2 grep or glob, and none a subagent. Terminal-Bench tasks are about a system more than a code
  base, so jig's search tools and subagents had little to do here: what separates the two agents is the
  loop and the prompt, not jig's extra tools.
- **jig's failures were the model's judgment, not the harness.** In `modernize-scientific-stack` it kept the
  legacy script's extra output, so the test read the wrong number, and its final summary claimed the output
  was exactly the two required lines. In `mteb-retrieve` it ignored the hint to use the installed `mteb`
  package and called the embedding model directly, which ranks slightly differently. In
  `filter-js-from-html` its filter blocked every attack but also changed 5 of 12 clean files, and in
  `adaptive-rejection-sampler` 7 of 8 tests passed.
- **Two runs of the same thing differ as much as the settings do.** The default and the `--no-subagents`
  run (the same agent, in effect) passed 7 of 8 each, but not the same 7: only the second solved
  `make-mips-interpreter`, which every other run, and mini-swe-agent, failed. One took 199 turns in all,
  the other 139, and most of that gap is that one long task (122 turns against 63). With one attempt per
  task, neither the effort level nor the subagent tool moved the pass rate or the cost by more than that.
- **Low effort thinks less per turn, but that isn't what decides the cost.** At `--effort low` a turn cost
  about 15% less (less thinking), and the total came out like the second default run's. On the six short
  tasks it cost more, because it took more turns (27 on `db-wal-recovery`, against 11 and 14).
- **On DeepSeek, compaction saves context, not money.** Compacting at 50k tokens (7 compactions in 8
  tasks) cut the context of an average turn by 62%, but the cost per turn stayed the same: what it saved
  was cached input, which DeepSeek charges about 50 times less for, while new input per turn rose 40%,
  since each compaction starts a prefix with nothing cached. It also took the most turns, 251 against 139
  to 199, many of them on `tune-mjcf` (61 against 15 to 24), where after compacting it read the task's
  files again and rewrote its test scripts: a summary keeps the conclusions, not the working state. At
  the default 200k only one task ever compacted (200k tokens into 1.9k).
- **A time limit doesn't stop the agent.** When a task's time runs out, Harbor stops waiting, but the
  agent's processes in the container carry on into the verification: jig made up to 9 more model calls
  after a limit. That holds for every agent, so the comparison is fair, but a pass right at the limit
  (`tune-mjcf` and `cobol-modernization`, for both agents) may owe something to it. Counting those as
  failures gives 13/20 against 14/20: the same picture.
- **The evaluation found five problems in jig, now fixed.** File tools confined to the project could not
  touch `/etc` or `/var` in a container (`--add-dir`); there was no way to get turns and tokens out
  (`--stats`); during a DeepSeek outage jig waited 10 minutes per attempt in silence (now 2 minutes, with
  a notice on each retry); an instruction starting with "-" was read as an option, so the adapter now
  passes `--` first (that task was re-run); and the commands the model ran could see jig's API key, which
  the model printed with `env` in one run (mini-swe-agent's model did the same). The key only went to the
  local logs (since scrubbed) and to DeepSeek itself; jig's commands no longer see it. That last fix came
  after the runs, and changes nothing else.

## Tests

```bash
npm test            # the tools, permissions, sandbox, snapshots, search, context, skills, MCP (against a
                    # hand-written server), hooks, subagents, running headless (--add-dir, --stats, a hung
                    # API), benchmark metrics, and the loop: no API calls
npm run typecheck
```

[CI](.github/workflows/ci.yml) runs both on Linux and macOS with Node 22 and 24, the sandbox tests
included (on Linux it installs bubblewrap and lifts Ubuntu's AppArmor limit on user namespaces), and
checks the benchmark's tasks with the oracle and noop agents, which needs no API key. The Linux setup
was tried locally in Debian containers as an ordinary user, with Node 22 and 24, before it went in.

## Roadmap

- [x] **1. Core loop:** streaming, `read_file` / `write_file` / `edit_file` / `bash`, step limit, approval prompt
- [x] **2. Reliability:** `grep` and `glob`; read-before-edit; CRLF handling; edit errors that point at the nearest match; permission modes with read-only commands allowed; hideable thinking; the benchmark
- [x] **3. Context:** `AGENTS.md`; token tracking with automatic and manual compaction; sessions saved as JSON Lines, with `--continue` and `--resume`; fixes for the two problems the benchmark found; three new benchmark tasks
- [x] **4. Safety:** macOS sandbox (writes only in the project, no network); `plan` mode; allow and deny rules; snapshots and `/undo`; prompt-injection guidance; read-before-edit narrowed to overwrites; two prompt-injection tasks
- [x] **5. Extensions:** Agent Skills with progressive disclosure; MCP client over stdio (official SDK) with restart; `PreToolUse` and `PostToolUse` hooks; read-only subagents; parallel read-only tool calls; project trust; three benchmark tasks for the extensions
- [x] **6. Evaluation:** Terminal-Bench 2.0 through Harbor against mini-swe-agent on the same model, with success rate, cost and turns per task; ablations of effort, compaction and subagents; `--add-dir`, `--stats`, and a 2-minute API timeout with retry notices
- [x] **7. Linux and CI:** a bubblewrap sandbox on Linux with the same policy and tests as on macOS, and a clear reason when it can't run; GitHub Actions on Linux and macOS with Node 22 and 24; benchmark tasks checked in CI, which caught two task checks that only worked on Node 26
