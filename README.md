# jig

A minimal coding agent for the terminal, written from scratch in TypeScript on the Anthropic Messages API
(Claude, or DeepSeek through its Anthropic-compatible endpoint), and on any OpenAI-compatible API (OpenAI,
DeepSeek's, or a local model through Ollama or vLLM). There is no agent framework: it is one
streaming tool-use loop, six tools, context management (AGENTS.md, saved sessions, compaction), safety
(an OS sandbox on macOS and Linux, permission modes, deny rules, snapshots with undo), extensions (Agent Skills, MCP
servers, hooks, subagents), a benchmark that measures each version, and a loop in which jig proposes
changes to its own code and a referee it can't reach measures them.

(A jig is the workshop fixture that holds a piece of work and guides the tool cutting it, which is what an
agent harness does for a model.)

## Highlights

- **Built from scratch.** No agent framework: one streaming tool-use loop, six tools and subagents, on the
  Anthropic Messages API (Claude, and DeepSeek through its compatible endpoint) and any OpenAI-compatible
  API (OpenAI, DeepSeek's, a local model through Ollama or vLLM). 209 tests, and CI on Linux and macOS.
- **Safe by construction.** Commands run in the operating system's sandbox (Seatbelt on macOS, bubblewrap
  on Linux); permission modes, deny rules, project trust, and snapshots with `/undo`. The API key never
  reaches the commands the model runs, and on Terminal-Bench it never enters the container.
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
  maintainers did (the same output on 148,188 generated inputs) and passed their tests, for $0.13 in all.

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
      --time-limit <s>  most seconds per task: at the limit jig stops, whatever is running (see below)
      --no-wrap-up      at --max-steps, stop without one more call (no tools) asking where the work stands
      --escalate <model>  once a test command the model runs fails, this model takes the steps left
      --no-subagents    leave out the subagent tool
      --tools <names>   give the model only some of jig's tools, e.g. --tools bash
      --hide-skill <name>  leave a skill out, as if it weren't installed (repeatable)
      --no-memory       leave out what jig remembers from earlier sessions
      --system-prompt <text>  use this system prompt instead of jig's own
      --stats <file>    keep a JSON file of the model calls, tokens, tool calls and mechanisms fired so far
      --check           in a one-shot run, ask the model to check its work before it finishes
      --reviewer <model>  before the task ends, this model checks the work against the task (read-only)
```

In a session: `/mode`, `/undo`, `/thinking`, `/skills`, `/mcp`, `/context`, `/compact`, `/reset`, `/help` and
`/exit`, and `/<skill> [task]` runs a skill. After each task jig prints the steps taken, the tokens sent and
received (subagents included), and how many input tokens came from the prompt cache. Up brings back earlier
tasks; a paste of several lines is one message, sent with Enter, and a line ending in `\` goes on in the
next. Ctrl+C stops a task, and at the prompt clears the line; on an empty prompt it says how to quit, and
pressed again it quits, as Ctrl+D does. Piped into jig, a session takes a task or command from each line,
one ending in `\` too.

A task given on the command line exits with 0 when the model finished, 1 on an error, 2 when it ran out
of steps, 3 when a reply hit the output limit or the context window, 4 when the model declined, 5 when
tool calls needed approval and there was no terminal to ask, 6 when the model was stuck repeating the
same tool calls (see below), 7 at `--time-limit`, 8 when the model gave a second reply with no text or
tool call (see below), and 130 on Ctrl+C. So
`jig "fix the tests" && git commit -am fix` doesn't commit after a run that stopped short.

`--stats` keeps a JSON file for scripts and evaluation harnesses, rewritten as the task runs: the stop
reason, steps, model calls, tokens (subagents' included), tool calls by name, seconds, and `events`, how
often each of jig's mechanisms fired: retries (`retry.api`, `retry.brokeOff`, `retry.quiet`), compactions,
the model asked again after a reply that wasn't an answer, calls that didn't run as asked (the permission
policy's refusals among them, `call.refused`), hooks' blocks, `--check` and the reviewer (or either one
skipped for time), `--escalate`, the stop for repeating and the wrap-up (`src/stats.ts` lists them).
So a change to one can be seen to run at all, which in milestone 28 only reading the sessions showed.

## What it does

### Safety

- **Sandbox.** Commands run in the operating system's sandbox, as in Codex and Claude Code: Seatbelt on
  macOS, [bubblewrap](https://github.com/containers/bubblewrap) on Linux. They can read anything but write
  only inside the project, its git directory (not its config or hooks, which name programs git runs),
  the directories added with `--add-dir` and the temp directories, and they can't reach the network
  (`--allow-network` lifts that). On macOS, localhost stays open; on Linux each command gets an empty
  network of its own, so a test can still start a server and talk to it, but only within one command.
  Only IP networking is cut off, though: a daemon listening on a Unix socket (Docker's, say) is still
  within reach. And commands share the machine's processes, so they can see yours and signal them.
  Because a sandboxed command can't change files outside the project or reach the network, in the
  default `edits` mode commands run without asking. On Linux the sandbox
  needs bubblewrap installed (`sudo apt install bubblewrap`) and user namespaces allowed; where it can't
  run, jig says why, and commands ask first. `--no-sandbox` turns it off.
- **File tools.** `read_file`, `grep`, `glob`, `write_file` and `edit_file` run in jig itself, outside the
  sandbox, so they keep to the project and the `--add-dir` directories on their own. A change goes by where
  its path really leads, so a symlink in the project can't take it outside; reading may follow a link out,
  as commands can read anything. They refuse the hidden paths in the settings (below), and don't change a
  git directory's `config` or hooks, or a `.git` file or `commondir` that tells git where they are, which
  could make git run programs outside the sandbox. The git that `grep` and `glob` run to list files
  runs with `core.fsmonitor` and hooks turned off, and without jig's API keys. `grep` matches in a worker
  thread that Ctrl+C stops, as do 30 seconds on one file, since a regular expression can take exponentially
  long on some lines.
  `edit_file` and `write_file` change only UTF-8 files: for a Latin-1 or UTF-16 file the model is told to
  use a command, and `read_file` says when what it shows isn't UTF-8. `read_file` reads a file a chunk at a
  time and keeps only the page it shows: 5 lines of a 300 MB log used to take 800 MB of memory. A file over
  537 MB, V8's longest string, is too big for `edit_file` and `write_file`, and they say to use a command.
- **Modes.** `plan` only looks: file changes and commands that change things are refused, and the model is
  told to propose a plan. `ask` asks before every change and command, `edits` (the default) lets file
  changes and contained commands through, and `auto` never asks. Reading never asks: `read_file`, `grep`,
  `glob`, and commands that only read inside the project (`ls`, `cat`, `sed -n 10,20p`, `git diff`, ...).
  When jig does ask, `[a]lways` approves that program (say, `python3`) for the rest of the session. On a
  file change it approves file changes only: commands still ask, even ones the sandbox contains.
  With no terminal to ask in (a script, CI), such a call is refused instead, and the third in a task
  stops it: `--yes`, or allow rules, let them run.
- **Rules.** `~/.jig/settings.json` and the project's `.jig/settings.json` can list commands to always
  allow or always refuse:

  ```json
  { "allow": ["npm test", "make"], "deny": ["git push", "npm publish"] }
  ```

  A deny rule is refused in every mode, even `auto`, and matches its words in order within one command, so
  `"git push"` also catches `git -C repo push origin` and `bash -c "git push"`. A deny rule can also name a
  tool, like `"mcp__github__merge_pull_request"`. The settings can also hold `"sandbox": false` or
  `"network": true` for a project, and `"hiddenPaths"`: files and folders sandboxed commands can't read at
  all, like `["~/.ssh", "~/.aws"]` (the model is told that some paths are hidden, not which). A project's
  hidden paths apply whether it is trusted or not, since they only restrict.
- **Project trust.** A repository's `.jig/settings.json` could start programs (hooks, MCP servers) or
  loosen the sandbox the moment you run jig in a repository you just cloned. So those parts only apply after
  you say yes to a prompt listing exactly what they would do; the answer is remembered for that version of
  the file, and any change asks again. Until then only its deny rules apply, since they only restrict.
- **Undo.** Before each task, jig snapshots the project's files into a private git repository in
  `~/.jig/snapshots/` (so it works in any folder and never touches the project's own git history), and
  `/undo` puts back every file the task changed, created or deleted, whether through the file tools or a
  command. `/undo` again goes one task further back. Projects with more than 200 MB of files that aren't
  ignored aren't snapshotted: the size is checked before every task, and a project that grows past it (a
  task downloads a dataset, say) turns `/undo` off for the rest of the session. Snapshots are never
  signed and run no hooks, whatever your git config says. When git fails (a lock another git left, say),
  `/undo` says why and keeps the snapshot, so you can try again.
- **Credentials stay with jig.** The commands the model runs get jig's environment without its API keys
  (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`). They never need them, and a model that
  runs `env` to look around, as both agents did in the Terminal-Bench runs, would otherwise copy the key
  into the conversation and the logs, where a prompt injection could also reach it. Hooks don't get them either.
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
  are answered as interrupted when a session is loaded, so the history is always valid. Each line says
  when it was written (`at`); a reply, how long its model call took, retries included (`ms`); and tool
  results, how long each call took (`toolMs`), in milliseconds, so a session shows where the time went.
  A project's directory there, as in `~/.jig/memory/` and `~/.jig/snapshots/`, is named after its real path
  and a short hash of it: a symlink to a project shares its sessions, and `/a/my-app` and `/a/my/app` no
  longer do. The sessions, memories and snapshots under the older name, the path alone, move to the new
  one together the first time, if the sessions saved there all started in this project; if there are
  none, or one started in another project, they all stay where they were.
- **Compaction.** jig tracks how many tokens the conversation takes up (measured from each reply's usage,
  estimated for tool output since, and from the text's length when a server reports no usage). Past
  `--compact-at` it asks the model to summarize the conversation and continues from that summary;
  `/compact` does it on demand and `/context` shows the numbers. Mid-task, the task's own words and a
  list of the file changes and commands so far follow the summary. When the API rejects a request as too
  long for the model, jig compacts and asks again, once (not with `--compact-at 0`). The conversation is
  then too long to summarize as well, so the summary is written from a copy with the tool output cut to
  its start and end, the oldest first (`/compact` does the same when the API rejects its request). Past
  `--compact-at`, a summary that fails doesn't end the task: it goes on as it is, and compaction is tried
  again 3 steps later. After the API's rejection it does, since the conversation can't go on as it is.
- **Long output.** Tool output over 40,000 characters (about 10k tokens) is cut from the middle, keeping
  its start and its end (errors and test summaries tend to be at the end). A command's whole output then
  goes to a file in the temp directory that only you can read, and the model is told where, so it can
  search what it didn't see instead of running the command again. Commands that only read one of these
  files while jig keeps it (`grep -n`, `sed -n 10,20p`, `tail`, ...) count as reading inside the project,
  so they don't ask, in plan mode too; other files with names like theirs don't count. The files hold 100
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
  wrong. `--no-memory` leaves memory out. What counts as a secret here, and is blanked out of
  `jig sessions export`: a key or token in the shape a provider gives out (`sk-`, `ghp_`, `github_pat_`,
  `glpat-`, `hf_`, `npm_`, `AIza`, `sk_live_` and others), a private key, a password assignment, and a
  password in a URL, unless its host is this machine or an example (`postgres://postgres:postgres@localhost`
  is fine). Exports blank out JWTs too.

### Extensions

- **Skills.** jig reads [Agent Skills](https://agentskills.io): folders with a `SKILL.md` (a name and a
  description in YAML frontmatter, then instructions) and maybe scripts and reference files. They are found
  in `.jig/skills`, `.agents/skills` and `.claude/skills`, in the project and in your home directory, then
  among jig's own (`skill-writer`), the project's winning on a name clash. jig's own skills are for
  writing skills, so a plain one-shot task leaves them out and a benchmark measures what it did before. Loading is progressive: the
  system prompt lists only each skill's name and description; the model calls the `skill` tool to load the
  instructions when a task matches, and reads the skill's other files only if the instructions point to
  them. `/<skill> [task]` loads one yourself. Skills can be installed, written and measured:

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
  `--project`); nothing runs at install. A skill the model writes (`jig skills new`, or `/skills new` and
  `/learn` in a session) is a proposal: jig checks it against the specification and shows it to you, and
  saves it only where you say, in the project or for all your projects. With no one to ask, it goes to
  `.jig/proposals/skills/`, a folder `jig skills add` can install once you have read it. A skill's evals
  live in `evals/evals.json`, in the format of Anthropic's `skill-creator` (a prompt, the expected output,
  expectations, input files) plus `check`, a shell command whose exit code says whether the result is
  right; `jig skills test` runs each eval in a fresh project with its own home directory, once with the
  skill and once with it hidden (`--hide-skill`), and grades it by the check and by the model judging the
  expectations.
- **MCP servers.** jig is an MCP client over stdio, on the official TypeScript SDK. Servers configured in
  the settings start with jig, and their tools join jig's own as `mcp__<server>__<tool>`:

  ```json
  { "mcpServers": { "tracker": { "command": "node", "args": ["tools/tracker-server.mjs"], "env": {} } } }
  ```

  A tool the server marks read-only runs like jig's own read tools; any other asks first (outside `auto`
  mode) and is refused in `plan` mode, because it acts outside the sandbox's reach. `[a]lways` approves one
  tool for the session; allow and deny rules can name tools too.
  A name keeps only letters, digits, `_` and `-` (the rest become `_`) and 64 characters, so two tools can
  come out with the same one (servers `db.prod` and `db prod`, say). Then each gets a short hash of its
  server's and its own name added, jig says so, and `/mcp` shows which server each is from; a deny rule
  or hook naming the name they shared applies to each.
- **Hooks.** Commands that run around tool calls, and before a task ends, configured like Claude Code's:

  ```json
  { "hooks": {
      "PreToolUse":  [{ "matcher": "bash", "command": "./scripts/check-command.sh" }],
      "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "ruff check \"$JIG_FILE\" 1>&2 || exit 2" }],
      "Stop":        [{ "command": "npm test 1>&2 || exit 2" }] } }
  ```

  `matcher` is a regular expression for whole tool names; `"*"`, or no matcher, matches every tool. A hook
  gets the call as JSON on stdin, plus `JIG_TOOL`, `JIG_FILE` and `JIG_PROJECT_DIR`. Exit code 2 from
  a `PreToolUse` hook blocks the call and its stderr tells the model why; from a `PostToolUse` hook, its
  stderr goes to the model with the result (a linter's complaints, say). A long stderr is cut from the
  middle, as tool output is, and isn't kept in a file; jig holds only its start and end, however much
  a hook prints. Any other failure is shown to you and otherwise ignored; a hook still running after 60
  seconds is stopped, with everything it started.

  A `Stop` hook runs when the model gives its final answer with a step left, so a project can say what
  done means: its tests pass, its linter is quiet. It takes no matcher, and gets JSON on stdin with the
  task, the answer (`last_message`), `stop_hook_active` (whether a Stop hook has sent the model back
  already in this task), `session_path` and `changed_files` (what the task changed, by its snapshot).
  Exit code 2, or `{"decision": "block", "reason": "..."}` on stdout, keeps the task going: the model is
  told the stderr or the reason, and works on. A long reason (a whole test log, say) is cut from the
  middle, as stderr is; a decision over 4 million characters isn't read, and jig says so. A task's Stop
  hooks send it back 3 times at most; after
  that, the task ends as finished, with a notice that the hook still objects. The 60 seconds apply here
  too: a test suite that takes longer is stopped, and doesn't hold the task up. Hooks for events jig
  doesn't have (`SessionStart`, say) are left out, with a warning, and the rest of the settings apply.
- **Subagents.** The `subagent` tool hands a research task (where is X handled, which files would a change
  touch) to a fresh agent loop with a context of its own. It gets the tools that only look, under `plan`
  mode's rules, never asks you anything, and returns only its findings, so the files it read don't fill the
  main conversation. Several subagent calls in one reply run at the same time.

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
             │   (calls that only read run at the same time, the others in order)
             │                                    │
             └──── all tool results, in one message ◀┘
```

| File | What it does |
| --- | --- |
| [`src/agent.ts`](src/agent.ts) | The loop: call the model, run the tools it asks for, send back the results, until it answers without a tool call; compact when needed; with `--escalate`, hand over to a stronger model once a test run fails |
| [`src/review.ts`](src/review.ts) | `--reviewer`: a second model, as a read-only subagent, checks the work against the task before it ends; and the prompt, verdict and re-check of a review that runs the work |
| [`src/review-cli.ts`](src/review-cli.ts) | `jig review`: a review of finished work that runs it, its commands going into a copy of the machine through `--exec`, for an evaluation harness to call |
| [`src/conversation.ts`](src/conversation.ts), [`src/session.ts`](src/session.ts) | A conversation's messages, size and saved session file |
| [`src/compact.ts`](src/compact.ts) | Replacing a conversation with the model's summary of it |
| [`src/model.ts`](src/model.ts) | Talks to the API: request settings per provider, streaming, checking streamed tool input, retries |
| [`src/openai.ts`](src/openai.ts) | The OpenAI-compatible API: the conversation as chat messages on the way out, the streamed reply as Messages API blocks on the way in |
| [`src/tools/`](src/tools) | `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `bash`, and `subagent` |
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
| [`src/sandbox.ts`](src/sandbox.ts) | The sandbox commands run in: a Seatbelt profile on macOS, bubblewrap's arguments on Linux |
| [`src/snapshots.ts`](src/snapshots.ts) | Snapshots of the project's files, and `/undo` |
| [`src/prompt.ts`](src/prompt.ts) | System prompt: how to work, facts about the environment, and the project's AGENTS.md |
| [`src/cli.ts`](src/cli.ts) | Arguments, interactive session, slash commands, approval and trust prompts, notes to the model, Ctrl+C |
| [`src/ui.ts`](src/ui.ts) | Terminal output: streamed text and thinking, tool calls, result previews; and the input, one readline for the session |
| [`src/version.ts`](src/version.ts) | jig's version, read from `package.json` (`--version`, and the MCP client's name) |
| [`src/stats.ts`](src/stats.ts), [`src/prices.ts`](src/prices.ts) | The `--stats` file: model calls, tokens, tool calls and the mechanisms that fired, kept up to date as a task runs; the price table |
| [`bench/`](bench) | The benchmark: tasks, runner and report; [`bench/memory/`](bench/memory) and `bench/memory.ts`, the memory benchmark |
| [`eval/`](eval) | Terminal-Bench through Harbor: jig's adapter, the runner, the task samples, the report and its results |

**When does the loop stop?** When a reply has no tool calls (the model's signal that it is done). With
`--check` in a one-shot run (`jig --check "task"`), the first time that happens jig asks the model to
check its work against the task, if a step is left for that, and stops at the next such reply. Also on
`--max-steps` model calls, at `--time-limit` seconds (a model call or command still running is stopped,
a question asking you to allow a tool call is closed unanswered, and none starts after; nor do `--check`
and `--reviewer` in the last quarter of the time, since what they find might not get done), on
Ctrl+C, and when a safety classifier declines the request. A reply cut off at the output limit isn't an
answer: jig asks the model to continue it, twice at most. Nor is one with no text and no tool call (empty,
or only thinking): it stays out of the history, and the model is asked once to go on. A second one ends
the task as `empty`, with no answer for `--check`, the reviewer or a Stop hook to check, and one on the
last step ends it out of steps; if that reply was cut off at the output limit, the task ends as cut off
(exit 3) instead.
A model can get stuck repeating itself, as milestone 27's trained one did: the same tool calls with the
same results 5 steps in a row stop the task (a subagent or a reviewer is then asked what it found, as at
its step limit), and a call identical to an earlier one in the same reply, with only reads between them,
isn't run (its result says which call it repeats).
At `--max-steps`, jig makes one more call, in which the model can't call tools, asking what it changed,
what it verified and how, and what is left, and prints the reply: the model's own report, not evidence.
Its tokens count in the totals and in `--stats`. `--no-wrap-up` leaves it out, as the runners in `bench/`
and `jig skills test` do, so that their steps and costs compare with earlier runs.
A `Stop` hook can send the model back to work from its final answer, after `--check` and the reviewer,
with a step left and 3 times a task at most (see Hooks).

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
| Does jig work? | the in-house benchmark: 20 tasks, hidden tests, 3 attempts each | 60 of 60 for every version since milestone 7, on macOS and Linux; no attempt followed a prompt injection |
| Against another agent? | Terminal-Bench 2.0, 20 tasks × 3, against mini-swe-agent on the same model (deepseek-flash) | 68% against 73%: 5 points behind (−3 to +15), within the noise, at 39% lower cost |
| On a real bug, filed after its model was in use? | [Python-Markdown #1651](examples/python-markdown-1651), filed after deepseek-flash was in use; the maintainers' tests hidden; 3 attempts | 3 of 3 solved, $0.13 in all; each fix renders 148,188 generated inputs exactly as upstream's does; one of the three explained why the bug depends on the Python version, and one ran out of steps before its summary |
| Does checking before finishing help? (9) | Terminal-Bench, the 20 tasks and 20 held-out ones | it fixed the failures it aimed at, ran others out of time and solved no more, at 38–65% more cost: opt-in |
| Do skills and memory work? (12, 13) | each with and without, 9 runs each | a skill learned from one session: 9 of 9 against 0 of 9; a convention remembered from an earlier session: 9 of 9 against 0 of 9 |
| Can jig improve its own code? (14–22, 28) | the evolve loop and its referee, on two suites | 19 candidates; one accepted (+15 and +17 points on the suite), then 15 points worse on Terminal-Bench, so not merged; neither advice in the prompt nor changes to the loop moved the suite, and two of the loop's changes never ran at all |
| A stronger model when the tests fail? (23) | the trigger replayed on 676 saved attempts; deepseek-v4-pro alone | the trigger would have reached 1 of 220 failures; v4-pro was 7 points ahead for 5 times the cost, while 2 more steps put flash 24 ahead |
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

## Tests

```bash
npm test            # the tools, permissions, sandbox, snapshots, search, context, skills, memory, MCP
                    # (against a hand-written server), hooks, subagents, running headless (--add-dir,
                    # --stats, a hung API, a session piped in), the prompt (pastes, history, Ctrl+C),
                    # benchmark metrics, the evolve referee and the copies candidates work in, exporting
                    # sessions, and the loop: no API calls
npm run typecheck
```

[CI](.github/workflows/ci.yml) runs both on Linux and macOS with Node 22 and 24, the sandbox tests
included (on Linux it installs bubblewrap and lifts Ubuntu's AppArmor limit on user namespaces), and
checks the benchmark's tasks with the oracle and noop agents, which needs no API key, and packs,
installs and runs the npm package. The Linux setup
was tried locally in Debian containers as an ordinary user, with Node 22 and 24, before it went in.

## Releasing

The npm package is `jig-agent`. Node won't strip types from files under `node_modules`, so the package
ships JavaScript: `npm pack` and `npm publish` first compile `src/` into `dist/` (`tsconfig.build.json`),
and the package holds only `dist/`, the README and the license. To release, bump the version with
`npm version <patch|minor|major>`, then `npm publish` from an npm account; CI's `package` job packs,
installs and runs the tarball on every push.

## License

MIT, see [LICENSE](LICENSE).
