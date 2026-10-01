# jig

A minimal coding agent for the terminal, written from scratch in TypeScript on the Anthropic Messages API
(Claude, or DeepSeek through its Anthropic-compatible endpoint). There is no agent framework: it is one
streaming tool-use loop, six tools, a permission policy, context management (AGENTS.md, saved sessions,
compaction), and a benchmark that measures each version.

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
                          ask    ask before every file change and command
                          edits  change files in the project freely, ask before commands
                          auto   never ask
  -y, --yes             same as --mode auto
      --hide-thinking   don't print the model's thinking (/thinking toggles it in a session)
  -c, --continue        continue this project's most recent session
      --resume <file>   continue a saved session (--sessions lists them)
      --compact-at <n>  summarize the conversation once it reaches n tokens (default: 200000; 0: never)
  -C, --cwd <dir>       project directory (default: the current directory)
      --max-steps <n>   most model calls per task (default: 50)
```

In a session: `/mode`, `/thinking`, `/context`, `/compact`, `/reset`, `/help` and `/exit`. After each task
jig prints the steps taken, the tokens sent and received, and how many input tokens came from the prompt
cache.

### When jig asks first

Reading never asks: `read_file`, `grep`, `glob`, and commands that only read inside the project (`ls`,
`cat`, `grep`, `git status`, `git diff`, `find` without `-exec`/`-delete`, and a few more). In the default
`edits` mode, file changes run without asking too, since the file tools can't leave the project. Any other
command asks `[y]es / [n]o / [a]lways allow python3 commands in this project`, where "always" covers that
program for the rest of the session. Commands with redirections, substitutions or paths outside the
project always ask. The policy is in [`src/permissions.ts`](src/permissions.ts).

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

## How it works

```
 task ──▶ messages ──▶ model (streamed) ──▶ reply has tool calls? ── no ──▶ done
             ▲                                    │ yes
             │                                    ▼
             │         for each call: check input ▶ permission policy ▶ run ▶ truncate output
             │                                    │
             └──── all tool results, in one message ◀┘
```

| File | What it does |
| --- | --- |
| [`src/agent.ts`](src/agent.ts) | The loop: call the model, run the tools it asks for, send back the results, until it answers without a tool call; compact when needed |
| [`src/conversation.ts`](src/conversation.ts), [`src/session.ts`](src/session.ts) | A conversation's messages, size and saved session file |
| [`src/compact.ts`](src/compact.ts) | Replacing a conversation with the model's summary of it |
| [`src/model.ts`](src/model.ts) | The only file that talks to the API: request settings per provider, streaming, checking streamed tool input |
| [`src/tools/`](src/tools) | `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `bash` |
| [`src/permissions.ts`](src/permissions.ts) | Which tool calls need the user's approval |
| [`src/prompt.ts`](src/prompt.ts) | System prompt: how to work, facts about the environment, and the project's AGENTS.md |
| [`src/cli.ts`](src/cli.ts) | Arguments, interactive session, slash commands, approval prompt, Ctrl+C |
| [`src/ui.ts`](src/ui.ts) | Terminal output: streamed text and thinking, tool calls, result previews |
| [`bench/`](bench) | The benchmark: tasks, runner and report |

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
- **Read before edit.** jig remembers each file's modification time and size as of the model's last read.
  `edit_file` and `write_file` refuse to change a file the model hasn't read, or one that changed since
  (a formatter, a command or the user edited it), so it never overwrites work it hasn't seen. Printing a
  file with `cat`, `head` or `tail` counts as reading it: the benchmark showed the model often reads that
  way, and refusing the edit afterwards only cost it a step.
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
- **Two providers, one format.** DeepSeek's Anthropic-compatible API lets the same SDK and message format
  serve both. DeepSeek does not support `is_error` on tool results, so for DeepSeek failures are marked
  with `Error:` in the text instead, and the Claude-only settings (adaptive thinking with short progress
  notes, prompt-cache breakpoints, a server-side fallback model if a safety classifier declines) are left
  out.

## Benchmark

`bench/` is a small benchmark in the style of Terminal-Bench: fifteen tasks, each a small project, an
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
npm run bench -- --ref m2 --label m2 --attempts 3   # milestone 2
npm run bench -- --label m3 --attempts 3            # the current code
npm run bench:report                                # compare the saved runs (Markdown)
```

Each run is saved to `bench/results/` (commit these: they are the evidence), with a fingerprint of the
task suite: the report warns when runs used different versions of the tasks, which are not comparable.
Logs of every attempt (the transcript, the diff the agent made, the check's output and jig's session file)
go to `bench/logs/`. Model output varies between runs, so use several `--attempts`: the report shows the
pass rate with its spread between rounds, and a difference smaller than that spread is noise.
`--jig-args "--compact-at 30000"` passes options to jig, for ablations of one setting.

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

This is an in-house suite: good for comparing versions of jig and settings (models, effort, tools), not
for comparing against other agents. For that, milestone 6 runs a public benchmark.

### What the first runs showed

On the first twelve tasks, with deepseek-flash and three attempts each, M1 solved 36/36 and M2 35/36.
Reading the logs turned that into four findings:

- **The suite was too easy.** M1 already solved everything, so the pass rate could not show an
  improvement. The three newer tasks are harder, and the reliability features are measured by failed tool
  calls, steps and tokens instead.
- **The one M2 failure was a bug in the benchmark.** `map-limit`'s documentation said it "throws" a
  RangeError, the model threw it immediately, and the hidden test only accepted a rejected promise. The
  test now accepts both.
- **M2's read-before-edit check misfired.** Six of M2's seven failed tool calls were edits refused right
  after the model had printed the file with `cat`. Files printed with `cat`, `head` or `tail` now count as
  read.
- **`settings-crlf` didn't test line endings, and hid a bug.** Its fix was a one-line change, which never
  contains a line ending, so M1 passed it too. Looking closer showed that an edit adding lines to a CRLF
  file wrote them with `\n`, leaving the file mixed. Fixed in M3, and the task now needs such an edit.

M2's runs used 15% fewer tokens on average, but almost all of that came from one task (`log-report`,
where the model happened to sample the log instead of printing it whole); on the other eleven M2 used
slightly more. With three attempts that is not a real difference either way.

## Tests

```bash
npm test            # tools, permissions, search, context, benchmark metrics, and the loop with a scripted fake model: no API calls
npm run typecheck
```

## Roadmap

- [x] **1. Core loop:** streaming, `read_file` / `write_file` / `edit_file` / `bash`, step limit, approval prompt
- [x] **2. Reliability:** `grep` and `glob`; read-before-edit; CRLF handling; edit errors that point at the nearest match; permission modes with read-only commands allowed; hideable thinking; the benchmark
- [x] **3. Context:** `AGENTS.md`; token tracking with automatic and manual compaction; sessions saved as JSON Lines, with `--continue` and `--resume`; fixes for the two problems the benchmark found; three new benchmark tasks
- [ ] **4. Safety:** a read-only plan mode, deny rules for commands, run commands in Docker, git snapshot before edits plus `/undo`
- [ ] **5. Extensions:** `SKILL.md` loader with progressive disclosure, MCP client over stdio, subagent tool, a pre-tool hook
- [ ] **6. Evaluation:** Terminal-Bench 2.x through Harbor; success rate, cost and turns per task; ablations (effort level, compaction, subagents) against mini-swe-agent on the same model
