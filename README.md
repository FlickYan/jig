# jig

A minimal coding agent for the terminal, written from scratch in TypeScript on the Anthropic Messages API
(Claude, or DeepSeek through its Anthropic-compatible endpoint). There is no agent framework: it is one
streaming tool-use loop, six tools, a permission policy, and a benchmark that measures each version.

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
  -C, --cwd <dir>       project directory (default: the current directory)
      --max-steps <n>   most model calls per task (default: 50)
```

In a session, `/mode`, `/thinking`, `/reset`, `/help` and `/exit` work. After each task jig prints the
steps taken, the tokens sent and received, and how many input tokens came from the prompt cache.

### When jig asks first

Reading never asks: `read_file`, `grep`, `glob`, and commands that only read inside the project (`ls`,
`cat`, `grep`, `git status`, `git diff`, `find` without `-exec`/`-delete`, and a few more). In the default
`edits` mode, file changes run without asking too, since the file tools can't leave the project. Any other
command asks `[y]es / [n]o / [a]lways allow `python3` commands in this project`, where "always" covers that
program for the rest of the session. Commands with redirections, substitutions or paths outside the
project always ask. The policy is in [`src/permissions.ts`](src/permissions.ts).

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
| [`src/agent.ts`](src/agent.ts) | The loop: call the model, run the tools it asks for, send back the results, until it answers without a tool call |
| [`src/model.ts`](src/model.ts) | The only file that talks to the API: request settings per provider, streaming, checking streamed tool input |
| [`src/tools/`](src/tools) | `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `bash` |
| [`src/permissions.ts`](src/permissions.ts) | Which tool calls need the user's approval |
| [`src/prompt.ts`](src/prompt.ts) | System prompt: how to work, plus facts about the environment |
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
  (a formatter, a command or the user edited it), so it never overwrites work it hasn't seen.
- **Line endings are the file's business.** The model writes `\n`; in a file that uses `\r\n`, edits are
  matched and written with `\r\n`, and `write_file` keeps an existing file's CRLF endings.
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

`bench/` is a small benchmark in the style of Terminal-Bench: twelve tasks, each a small project, an
instruction worded the way a user would ask, hidden tests, and a reference solution.

For each attempt the runner:
1. copies the task's project to a temporary directory and commits it to a fresh git repository;
2. runs jig on the instruction (`--yes`, with a step limit and a timeout);
3. copies in the hidden tests, which the agent never saw, and runs them. Passing means solved.

It records whether each attempt passed, plus steps, tool calls, failed tool calls, tokens, estimated cost
and time. It reads these from jig's own terminal output, so it can measure any version of jig: `--ref m1`
runs the code tagged `m1`.

```bash
npm run bench -- --ref m1 --label m1 --attempts 3   # milestone 1
npm run bench -- --label m2 --attempts 3            # the current code
npm run bench:report                                # compare the saved runs (Markdown)
```

Each run is saved to `bench/results/` (commit these: they are the evidence). Logs of every attempt,
including the transcript and the diff the agent made, go to `bench/logs/`. Model output varies between
runs, so use several `--attempts`: the report shows the pass rate with its spread between rounds. A
difference smaller than that spread is noise.

`npm run bench -- --agent oracle` applies every reference solution and must pass all tasks;
`--agent noop` changes nothing and must fail them all. Together they show each task is solvable and not
already solved, without spending anything on a model.

| Task | What it tests |
| --- | --- |
| `pagination` | Two bugs in one function family (Python) |
| `settings-crlf` | Fixing a file with Windows line endings without converting it |
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

This is an in-house suite: good for comparing versions of jig and settings (models, effort, tools), not
for comparing against other agents. For that, milestone 6 runs a public benchmark.

## Tests

```bash
npm test            # tools, permissions, search, benchmark metrics, and the loop with a scripted fake model: no API calls
npm run typecheck
```

## Roadmap

- [x] **1. Core loop:** streaming, `read_file` / `write_file` / `edit_file` / `bash`, step limit, approval prompt
- [x] **2. Reliability:** `grep` and `glob`; read-before-edit; CRLF handling; edit errors that point at the nearest match; permission modes with read-only commands allowed; hideable thinking; the benchmark
- [ ] **3. Context:** load `AGENTS.md`; count tokens and compact near the limit (summarize the whole conversation into one message, or use server-side compaction: keeping the last few turns verbatim after a summary invalidates their thinking blocks); save sessions as JSONL and `--resume` them; track the cache hit rate
- [ ] **4. Safety:** a read-only plan mode, deny rules for commands, run commands in Docker, git snapshot before edits plus `/undo`
- [ ] **5. Extensions:** `SKILL.md` loader with progressive disclosure, MCP client over stdio, subagent tool, a pre-tool hook
- [ ] **6. Evaluation:** Terminal-Bench 2.x through Harbor; success rate, cost and turns per task; ablations (effort level, compaction, subagents) against mini-swe-agent on the same model
