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
      --escalate <model>  once a test command the model runs fails, this model takes the steps left
      --no-subagents    leave out the subagent tool
      --tools <names>   give the model only some of jig's tools, e.g. --tools bash
      --hide-skill <name>  leave a skill out, as if it weren't installed (repeatable)
      --no-memory       leave out what jig remembers from earlier sessions
      --system-prompt <text>  use this system prompt instead of jig's own
      --stats <file>    keep a JSON file with the model calls, tokens and tool calls so far
      --check           in a one-shot run, ask the model to check its work before it finishes
      --reviewer <model>  before the task ends, this model checks the work against the task (read-only)
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
  wrong. `--no-memory` leaves memory out.

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

### Improving itself

What jig can change about itself, and who decides whether it does:

| what | how | who decides |
|------|-----|-------------|
| its skills | `propose_skill` (`jig skills new`, `/learn`), measured with and without by `jig skills test` | you, when jig shows it to you |
| what it remembers, and a project's AGENTS.md | `propose_memory` and `propose_instructions` (`/remember`, `/reflect`) | you, one proposal at a time |
| its prompts, tools and loop | `npm run evolve -- run`: jig changes a copy of its own code, and a referee measures the change on benchmark tasks it wasn't made from | the referee, then you, by merging its branch or not |
| its model | `jig sessions export` writes conversations as fine-tuning data; `bench/export.ts` writes only the benchmark attempts that passed their hidden tests | whoever trains a model: jig doesn't |

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
```

A candidate works on a copy of jig without the benchmarks, in a repository with no history, and may
change only `src/` and `skills/`; the referee runs from the main checkout, so nothing a candidate
changes can change how it is judged. Milestone 14 describes the loop and what it found, milestone 15
the suite it runs on now, whose tasks are judged at a budget of 4 steps, milestone 16 the first
change it accepted, milestone 17 why that change wasn't merged (it cost Terminal-Bench 15 points), and
milestone 18 a cheaper check that would have let it through.

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
| [`src/review.ts`](src/review.ts) | `--reviewer`: a second model, as a read-only subagent, checks the work against the task before it ends |
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
| [`src/hooks.ts`](src/hooks.ts) | Running hooks around tool calls |
| [`src/permissions.ts`](src/permissions.ts), [`src/settings.ts`](src/settings.ts) | Which tool calls run, need approval, or are refused; allow and deny rules; settings files and project trust |
| [`src/sandbox.ts`](src/sandbox.ts) | The sandbox commands run in: a Seatbelt profile on macOS, bubblewrap's arguments on Linux |
| [`src/snapshots.ts`](src/snapshots.ts) | Snapshots of the project's files, and `/undo` |
| [`src/prompt.ts`](src/prompt.ts) | System prompt: how to work, facts about the environment, and the project's AGENTS.md |
| [`src/cli.ts`](src/cli.ts) | Arguments, interactive session, slash commands, approval and trust prompts, notes to the model, Ctrl+C |
| [`src/ui.ts`](src/ui.ts) | Terminal output: streamed text and thinking, tool calls, result previews |
| [`src/version.ts`](src/version.ts) | jig's version, read from `package.json` (`--version`, and the MCP client's name) |
| [`src/stats.ts`](src/stats.ts), [`src/prices.ts`](src/prices.ts) | The `--stats` file: model calls, tokens and tool calls, kept up to date as a task runs; the price table |
| [`bench/`](bench) | The benchmark: tasks, runner and report; [`bench/memory/`](bench/memory) and `bench/memory.ts`, the memory benchmark |
| [`eval/`](eval) | Terminal-Bench through Harbor: jig's adapter, the runner, the task samples, the report and its results |

**When does the loop stop?** When a reply has no tool calls (the model's signal that it is done). With
`--check` in a one-shot run (`jig --check "task"`), the first time that happens jig asks the model to
check its work against the task, and stops at the next such reply. Also on `--max-steps` model calls, on
Ctrl+C, and when a safety classifier declines the request.

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
- **jig hides its arguments.** Models stop programs by matching their command lines
  (`pkill -f server.py`), and jig's arguments hold the task, which names the very files and programs a
  model might stop: twice in milestone 10 the model's command killed jig. So jig sets its process title to
  `jig`, which hides its arguments on macOS and Linux, and reads the task from stdin when it is `-`, for
  the places the title can't reach (an x86-64 container on Apple Silicon, where Rosetta keeps the
  original command line, and the shell that started jig).
- **A command is done when its shell exits.** Waiting until the output pipes close, as jig did before
  milestone 10, also waits for whatever still holds them, and a server started with
  `cd app && server > log &` does: `&` puts the whole list in the background, and the subshell running it
  keeps the pipes open while it waits for the server. jig sat out the timeout and then killed the server
  with the process group. On Terminal-Bench that happened in 22 of the 55 calls that started something in
  the background. Now a call returns a second after the shell exits, tells the model that something it
  started is still running, and leaves it running.
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
- **A skill the model writes is a proposal.** A skill outlives the session that made it: its description
  is in every later system prompt and its instructions get followed, so a wrong one keeps doing harm. The
  model therefore can't write skill files; it calls `propose_skill`, jig checks the skill against the
  specification and shows it, and you choose where it goes, or that it goes nowhere. This is the first
  piece of jig changing itself, and it follows the rule the later pieces will: jig proposes, you approve.
- **A skill is measured against its own absence.** A skill that changes nothing still costs about 100
  tokens in every request, and a pass rate alone can't tell a helpful skill from an easy eval. So `jig
  skills test` runs each eval twice, with the skill and with it hidden, in a fresh project with a home
  directory of its own, so no other skill or setting takes part. A check command grades what can be
  checked; a model grades the rest, from the diff and the agent's final message only.
- **Installed skills carry their provenance.** A skill can bring scripts the model will run, so `jig
  skills add` lists them before anything is installed, runs nothing, and records the source and commit in
  a lockfile; `update` shows which files changed before replacing any. Repositories are cloned shallow
  and sparse, so one skill from a large collection fetches only its own folder.
- **Memory lives outside the repository.** A memory is something the model takes as its own past
  learning, so a file in a cloned repository must not be able to plant one. Memories go under
  `~/.jig/memory/`, a project's keyed by its real path; what everyone working on a project should know
  goes in its AGENTS.md, where it is visible and reviewed like any other change, and jig proposes those
  edits as diffs.
- **One file per memory, and jig builds the index.** The model never maintains a list that could drift
  from the files: at the start of a session jig reads each memory's frontmatter and puts the index in the
  system prompt, and each memory stays a file you can read, edit or delete.
- **Reflection happens when you ask for it.** Proposals interrupt, so they come together at the end
  (`/reflect`, `jig memory reflect`) or when you say to remember something, not in the middle of a task.
  The model is told to keep one fact per memory, to update rather than duplicate, and to leave out what
  the code, git history or AGENTS.md already say.
- **Proposals run one at a time, in any mode.** Tools that propose a change to jig itself have their own
  kind, `propose`: plan mode allows them (nothing changes unless you agree), they never run in parallel
  (their questions would overlap, as `propose_skill`'s could in milestone 12), and subagents don't get them.
- **Nothing that looks like a secret is written down.** A memory goes into every later prompt, so a key
  pasted into one would leak from then on. Memories, AGENTS.md edits and skills are refused if they hold
  something shaped like an API key, a token, a private key or a password assignment.
- **jig never judges its own changes.** Reading a change to a prompt says little about whether it helps,
  and a judge the change could reach could be changed with it. So a candidate may change only `src/` and
  `skills/`; it works on a copy that has no benchmarks and, being a new repository, no history to find
  them in (the analysis caught jig searching git history for hidden tests, and in milestone 10 both
  agents fetched a benchmark's answers); and it is judged by the main checkout's tests, tasks, runner
  and referee. A candidate that names the tasks (their ids, files, functions or flags) is rejected
  unread.
- **A referee is worth its false acceptances.** Before any candidate ran, the referee was run on
  simulated candidates that change nothing: judged on point estimates (solve more, or as many for less),
  11% of them were accepted, and with its rules 0.2%. That figure held the baseline fixed, and a second
  run of the baseline showed what it missed: the run the analysis comes from is a sample too, and its
  bad luck becomes every candidate's gain (4% against that run). So the simulation draws the baseline as
  well, and candidates are compared with baseline runs the analysis didn't see. Once those runs are
  made, their luck is part of every verdict: against one unlucky run, a change that does nothing would
  have been accepted 9% of the time, so candidates meet every unseen run, pooled, and `calibrate`
  reports the rate against them as they came out.
- **An accepted change is checked where jig is used.** The evolve suite is a proxy, small tasks at 4
  steps, and the referee measures only the proxy: milestone 16's accepted change solved more of it and
  15 points less of Terminal-Bench. So before a candidate is merged, it runs on Terminal-Bench against
  jig where it branched, in alternating rounds (`tbcheck`, milestone 19). A cheaper stand-in for that
  check would have to agree with it first: milestone 18's exploration suite didn't, and preferred the
  change Terminal-Bench turned down.
- **The answers are out of the agent's reach.** A sandbox that lets commands read anything lets them read
  a benchmark's hidden tests too, and one attempt did. Benchmark runs hide them (`hiddenPaths`), and the
  scripts that set a task up get its folder; jig doesn't.
- **A suite's difficulty is measured, not designed.** Tasks that look hard (denser specs, a time limit,
  a hang to find, conventions only the code shows) were solved at 88 to 100%, and a referee can only
  reward what a suite leaves to gain. What made the evolve suite hard enough was a limit jig works
  under, four steps, chosen by measuring 10, 8, 6 and 4: it belongs to the suite (`suite.json`), every
  run records it, and the referee won't compare runs made under different limits.
- **Training data is checked by something other than the model.** jig doesn't train models, but its
  sessions are what one would be trained on, and the benchmark knows which of them succeeded:
  `bench/export.ts` keeps only attempts that passed hidden tests the model never saw, as in rejection-
  sampling fine-tuning. Exports blank out anything that looks like a secret, in the strings rather than
  the JSON text, so an escaped quote can't be cut in half, and only what looks like a secret: the rule
  that refuses a memory with `token = ...` in it blanked out `token = tokens[index]` in the first
  export, which would have taught a model to write `[REDACTED]`.
- **Calls that only read run at the same time.** When every call in a reply is a read (file reads,
  searches, subagents, read-only MCP tools), they run in parallel; if any call changes something, they
  all run in order, since one may depend on another. Results still go back in the order of the calls, and
  in the terminal a result that doesn't follow its own call says whose it is.
- **MCP servers come back.** Ctrl+C in a terminal reaches every process in the foreground group, MCP
  servers included, and servers crash. A tool call to a server that has stopped starts it again.
- **A subagent that runs out of steps still reports.** Hitting its step limit mid-research would waste
  everything it read, so it gets one more call, without tools, to write up what it found.
- **Checking before finishing is opt-in.** With nobody to look at the result, a model that declares a
  task done after a quick look has the last word; on Terminal-Bench, 15 of jig's 18 failures were tasks it
  finished on its own and got wrong. `--check` makes one-shot runs tell the model nobody can answer and
  ask it, the first time it stops, to show what proves each of the task's requirements. It fixed the
  failures it was aimed at, but ran other tasks out of time and solved no more overall, at 38-65% more
  cost (see [milestone 9's results](#milestone-9-checking-before-finishing)), so it is off by default.
- **Waiting on the API is bounded and visible.** The SDK's timeout covers only the wait for a response
  to start (a stream's first bytes arrive within seconds when the API is healthy, however long the reply
  runs), so jig sets it to 2 minutes instead of 10, and prints a notice for each automatic retry. During a
  DeepSeek outage in milestone 6, jig had sat silent for half an hour. The SDK retries only requests that
  fail before their reply begins, so jig itself asks again, up to twice, when a reply breaks off partway:
  the connection drops, the stream ends early, or an overload error arrives mid-stream. In milestone 10
  one dropped connection had ended a Terminal-Bench task.
- **One message format, translated at the edge.** DeepSeek's Anthropic-compatible API lets the same SDK
  and message format serve Claude and DeepSeek. DeepSeek does not support `is_error` on tool results, so
  for DeepSeek failures are marked with `Error:` in the text instead, and the Claude-only settings
  (adaptive thinking with short progress notes, prompt-cache breakpoints, a server-side fallback model if a
  safety classifier declines) are left out. An OpenAI-compatible API gets the same conversation translated
  in [`src/openai.ts`](src/openai.ts), and its reply is translated back into the Messages API's blocks, so
  the agent loop, sessions, compaction and tools don't know which API they ran on. Thinking goes back as
  `reasoning_content`, which DeepSeek requires on every earlier reply once tools are declared; each tool
  result becomes a `tool` message right after its call; cached tokens, which the chat API counts inside
  the prompt, are counted apart as on the Messages API. Claude stays on the Messages API.

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
The answers stay out of the attempts' reach: since milestone 18, the commands jig runs during a benchmark
can't read the tasks' folders, the other attempts' logs and sessions, `eval/` or the repository's history
(`bench/hidden.ts` writes them into the run's jig settings as `hiddenPaths`).
The fingerprint is taken as a run starts and again as it ends, and a run whose tasks changed in between
records both (`suiteAtEnd`).
Since milestone 14 each attempt also records its session, the conversation jig saved, for
`bench/export.ts`, and for `bench/escalation.ts`, which replays a routing trigger on it. Two more suites are the ones jig evolves on: `--suite evolve` (`bench/evolve/tasks`,
milestone 14's) and `--suite evolve2` (`bench/evolve2/tasks`, milestone 15's), each with its results in
`bench/results/<suite>/`. A suite may set its own step limit in `bench/<suite>/suite.json`; evolve2's
is 4.
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

**M7 on macOS and on Linux, M10, M11 through the OpenAI-compatible API, M12 and M15**, on the current
suite (deepseek-flash, three attempts per task):

| run | passed | steps | tool calls | failed tool calls | tokens in | cost | time |
|-----|--------|-------|------------|-------------------|-----------|------|------|
| m7 (macOS, Seatbelt) | 100% (60/60) | 7.0 | 8.9 | 0.0 | 30,795 | $0.0047 | 14s |
| m7-linux (Debian container, bubblewrap) | 100% (60/60) | 7.0 | 8.7 | 0.0 | 30,780 | $0.0043 | 13s |
| m10 (macOS) | 100% (60/60) | 6.7 | 8.5 | 0.0 | 27,645 | $0.0041 | 13s |
| m11, `--api openai` (macOS) | 100% (60/60) | 7.2 | 9.2 | 0.0 | 35,683 | $0.0045 | 14s |
| m12 (macOS) | 100% (60/60) | 6.7 | 8.8 | 0.0 | 28,773 | $0.0044 | 13s |
| m15 (macOS) | 100% (60/60) | 7.2 | 9.2 | 0.0 | 30,677 | $0.0044 | 14s |

Every attempt passed on both systems, so nothing in milestones 6 and 7 cost a task. The Linux run ran
jig as an ordinary user in a Debian container, every command in the bubblewrap sandbox; no command
tripped over it (none was refused a write), and as on macOS no attempt acted on the prompt injections
(0 of 6). Getting the benchmark onto Linux also found a bug in it: two tasks ran their hidden tests with
`node --test bench_tests/`, which only Node 26 accepts, so on Node 22 and 24 their reference solutions
failed. They now pass the test files by name. That changed the suite's fingerprint, so these runs aren't
directly comparable with the ones below, though no task changed.

M10 changed how commands end, retries and the process title; it cost no task here either, and again no
attempt acted on the prompt injections (0 of 6). Through DeepSeek's OpenAI-compatible API (M11), jig
passed every attempt too, at about the same cost. M12's skills left the benchmark's tasks as they were
(jig's own skills stay out of a plain one-shot task): all passed again. So did M15's jig, with the
memory of M13 and the session records of M14, run alongside milestone 16's candidate (which lost one,
in `experiments/`), and again no attempt acted on the prompt injections (0 of 6).

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
eval/run.sh tb-jig jig -k 3                     # jig on the 20 tasks in eval/subset.txt, 3 attempts each
eval/run.sh tb-mini mini-swe-agent -k 3         # the baseline
eval/run.sh abl-effort-low jig --ak effort=low  # an ablation: any jig option, through the adapter
python3 eval/report.py eval/results/tb-jig.json eval/results/tb-mini.json   # the first table below
python3 eval/report.py --only eval/ablation-subset.txt eval/results/tb-jig.json eval/results/abl-*.json
```

- [`eval/jig_agent.py`](eval/jig_agent.py) is jig's Harbor adapter. It installs Node and jig from this
  checkout in each task's container, runs `jig --yes --add-dir / --stats …` on the instruction (the
  container is the sandbox, so the whole file system is the project), and reads the turns and tokens back
  from the stats file. The API key stays on the host: jig in the container gets a token of the run, and
  its requests go through [`eval/key_proxy.py`](eval/key_proxy.py), which puts the key in (milestone 25).
- The tasks are a seeded random sample of 20 of the 61 that ask for 2 GB of memory, one CPU and at most 30
  minutes ([`eval/subset.txt`](eval/subset.txt)), because this Mac gives Docker 3 GB. The task images are
  x86-64, so on Apple Silicon everything in them runs under emulation, for both agents alike, while the
  time limits stay as they are.
- Three attempts per task: one in milestone 6, two more in milestone 8 with the code tagged `m6` (what was
  evaluated, plus the API-key fix, which changes nothing else) and mini-swe-agent pinned to the version of
  the first round, 2.4.6. That makes 60 trials per agent. The ablations had one attempt each.
- A pass rate's 95% interval comes from resampling tasks, since attempts at the same task aren't
  independent, and a difference between two runs is paired by task.
- Costs come from the token counts and one price table for both agents. DeepSeek's off-peak discount made
  part of the actual bill lower (the first two tasks were billed at about half the table's price).
- **Looking up the benchmark counts as failing.** The tasks, with their tests and reference solutions, are
  public on GitHub, and the task containers can reach the internet. Milestone 10 found that both agents
  sometimes fetched them, so [`eval/report.py`](eval/report.py) checks every command of every trial, and an
  attempt that fetched anything from the benchmark's repositories counts as failed, whatever the verifier
  said. The numbers here are all counted that way; before milestone 10, this section counted those passes.

### Results

| run | passed | 95% CI | looked up | turns | tokens in | tokens out | cost | agent time |
|-----|--------|--------|-----------|-------|-----------|------------|------|------------|
| jig | 68% (41/60) | 52–83% | 1 (passed) | 22.9 | 1,102k | 31k | $0.049 | 5.0 min |
| mini-swe-agent | 73% (44/60) | 58–87% | 7 (5 passed) | 33.9 | 2,397k | 49k | $0.080 | 7.1 min |

Averages are per attempt; "looked up" counts the attempts that fetched the benchmark's own files, which
count as failed. Paired by task, mini-swe-agent is ahead by 5 points (95% CI −3 to +15), which these
runs can't tell from noise. (Counting the look-ups as passes, as this section did before milestone 10,
put it 12 points ahead, +3 to +22.) Both solved 9 tasks in every attempt, three (`chess-best-move`,
`dna-assembly`, `tune-mjcf`) two times in three, and `filter-js-from-html` and `make-mips-interpreter`
never. They differ on six:

| task | jig | mini-swe-agent |
|------|-----|----------------|
| `adaptive-rejection-sampler` | 0/3 | 2/3 |
| `db-wal-recovery` | 3/3 | 2/3, and a look-up |
| `headless-terminal` | 1/3 | 2/3, and a look-up |
| `model-extraction-relu-logits` | 1/3 | 2/3 |
| `modernize-scientific-stack` | 2/3 | 3/3 |
| `mteb-retrieve` | 1/3, and a look-up | 0/3: three look-ups |

The full matrix is in `python3 eval/report.py eval/results/tb-jig.json eval/results/tb-mini.json`.

Ablations, on 8 of the 20 tasks ([`eval/ablation-subset.txt`](eval/ablation-subset.txt), again a seeded
sample), one attempt each, against the default's three attempts at the same 8:

| run | passed | turns | tokens in | tokens out | cost | agent time | against the default |
|-----|--------|-------|-----------|------------|------|------------|---------------------|
| jig, default | 20/24 | 23.5 | 1,417k | 27k | $0.051 | 4.7 min | |
| `--effort low` | 7/8 | 18.6 | 779k | 20k | $0.034 | 3.2 min | +4 points (0 to +12) |
| `--compact-at 50000` | 6/8 | 31.4 | 681k | 38k | $0.068 | 6.3 min | −8 points (−25 to 0) |
| `--no-subagents` | 7/8 | 17.4 | 865k | 22k | $0.036 | 4.0 min | +4 points (−25 to +38) |

The model never called the subagent tool on these tasks (see below), so `--no-subagents` is in effect
one more run of the default.

What the runs and their logs showed:

- **The two solve about as many; jig costs less.** With one attempt per task (milestone 6) they were
  even, 75% each (80% for mini-swe-agent as scored then); three attempts put mini-swe-agent 5 points
  ahead, within the noise. jig did its share with a third fewer turns, 54% fewer input tokens and 39%
  lower cost.
- **Where they differ.** In `adaptive-rejection-sampler`, all three of jig's samplers refused the form in
  which the tests pass the lower bound (`'lower' must be a single number`), the same mistake three times;
  in `headless-terminal` two of jig's attempts crashed (next point); the rest are single misses either
  way.
- **Two of jig's attempts were killed for memory.** In `headless-terminal` jig searched the whole container
  with its grep tool, which read each file whole before checking its size, and the container's 2 GB
  limit killed it (exit 137). grep now checks a file's size before reading it and skips `/proc`, `/sys`
  and `/dev`. Run directly in the task's image with its 2 GB limit, the old grep searching `/` is killed
  exactly as in the runs (exit 137), and the fixed one finishes in 2 seconds using 183 MB. Three more
  attempts at the task with the fix had no crash (two passed); they are kept apart from the results above.
- **In a container, the model works through bash.** Of jig's 1,498 tool calls, 1,208 (81%) were bash, 281
  the file tools, 9 grep or glob, and none a subagent. Terminal-Bench tasks are about a system more than a
  code base, so jig's search tools and subagents had little to do here: what separates the two agents is
  the loop and the prompt, not jig's extra tools.
- **Apart from those crashes, jig's failures were the model's judgment, not the harness.** In
  `modernize-scientific-stack` (round 1) it kept the legacy script's extra output, so the test read the
  wrong number, and its final summary claimed the output was exactly the two required lines. In
  `mteb-retrieve` (round 1) it ignored the hint to use the installed `mteb` package and called the
  embedding model directly, which ranks slightly differently. In `filter-js-from-html` its filters block
  every attack but also change clean files.
- **No ablation beats the noise.** Against the default's three attempts, every ablation's difference has an
  interval that reaches zero. The `--no-subagents` run, in effect a fourth default run, solved
  `make-mips-interpreter`, which the default failed all three times, and took 139 turns where the
  default's rounds took 182 to 199: one long task moves a run's cost more than any setting did.
- **Low effort thinks less per turn, but that isn't what decides the cost.** At `--effort low` a turn cost
  17% less ($1.81 against $2.19 per thousand turns, from less thinking), but how many turns a task takes
  varies more than that: on the six short tasks it took more turns (27 on `db-wal-recovery`, against 11
  to 14) and cost more.
- **On DeepSeek, compaction saves context, not money.** Compacting at 50k tokens (7 compactions in 8
  tasks) cut the context of an average turn by 64%, but the cost per turn stayed the same: what it saved
  was cached input, which DeepSeek charges about 50 times less for, while new input per turn rose 39%,
  since each compaction starts a prefix with nothing cached. It also took the most turns, many of them
  on `tune-mjcf` (61 against 15 to 24), where after compacting it read the task's files again and rewrote
  its test scripts: a summary keeps the conclusions, not the working state. At the default 200k only one
  task ever compacted (200k tokens into 1.9k).
- **jig keeps its API key away from the model; mini-swe-agent doesn't.** Models look around with `env`.
  mini-swe-agent's commands inherit its environment, so its model printed the API key into its own
  context in 6 of its 60 attempts. jig's did once, in 44 attempts before milestone 6's fix, and never in
  the 43 since: its commands don't get jig's keys. (As root in a container, though, a command can still
  read another process's environment: milestone 24 had one such trial, and since milestone 25 the
  container holds only a token of the run.)
- **A time limit doesn't stop the agent.** When a task's time runs out, Harbor stops waiting, but the
  agent's processes in the container carry on into the verification: jig made up to 9 more model calls
  after a limit. That holds for every agent, so the comparison is fair, but a pass right at the limit
  may owe something to it. Each agent had three, on the same tasks (`tune-mjcf` twice and
  `cobol-modernization` once); counting them as failures gives 38/60 against 41/60, the same gap.
- **The evaluation found six problems in jig, now fixed.** File tools confined to the project could not
  touch `/etc` or `/var` in a container (`--add-dir`); there was no way to get turns and tokens out
  (`--stats`); during a DeepSeek outage jig waited 10 minutes per attempt in silence (now 2 minutes, with
  a notice on each retry); an instruction starting with "-" was read as an option, so the adapter now
  passes `--` first (that task was re-run); the commands the model ran could see jig's API key, which the
  model printed with `env` in one run (mini-swe-agent's model did the same; the key only went to the
  local logs, since scrubbed, and to DeepSeek itself); and grep read files whole before checking their
  size. The last two fixes came after the runs that found them.

### Milestone 9: checking before finishing

mini-swe-agent's apparent lead invited a closer look at how jig loses. 15 of its 18 failures were tasks it
finished on its own and got wrong, some after a quick look: on `mteb-retrieve` and
`model-extraction-relu-logits` it stopped after 6 to 9 turns, where mini-swe-agent's passing attempts took
19 to 36. mini-swe-agent's prompt prescribes a workflow (reproduce, fix, verify, test edge cases) and lets
it stop only through an explicit command. So `--check` tells the model in one-shot runs that nobody can
answer and to finish only once the work is checked, and the first time it stops, asks it to show what
proves each of the task's requirements.

To keep from fitting the change to the tasks it came from, it was also measured on 20 held-out tasks: a
seeded sample of the 41 eligible tasks not in the original 20 ([`eval/heldout.txt`](eval/heldout.txt)),
one attempt each, against `m8` (the same jig without the change) and mini-swe-agent.

```bash
eval/run.sh tb-jig-m9 jig -k 3 --ak check=true             # the original 20, with the check
export TASKS="$(grep -v '^#' eval/heldout.txt)"
eval/run.sh ho-jig-m8 jig --ak ref=m8                      # the held-out 20, without it
eval/run.sh ho-jig-m9 jig --ak check=true                  # with it
eval/run.sh ho-mini mini-swe-agent --ak version=2.4.6
python3 eval/report.py eval/results/ho-jig-m8.json eval/results/ho-jig-m9.json eval/results/ho-mini.json
```

| tasks | jig without the check | jig with `--check` | difference | mini-swe-agent |
|-------|-----------------------|--------------------|------------|----------------|
| original 20, 3 attempts | 68% (41/60), $0.049 | 73% (44/60), $0.068 | +5 points (−3 to +15) | 73% (44/60), $0.080 |
| held-out 20, 1 attempt | 70% (14/20), $0.033 | 70% (14/20), $0.054 | +0 points (−20 to +20) | 80% (16/20), $0.054 |

Attempts that fetched the benchmark's own files count as failed (see milestone 10, which found them);
the first version of this table counted them as passes.

- **It fixed what it aimed at, and lost as much to the clock.** On the original tasks it solved
  `adaptive-rejection-sampler` twice (0 of 3 before), and `model-extraction-relu-logits` and
  `modernize-scientific-stack` more often, but 12 attempts ran into their time limit against 4 before
  (6 of them failed, against 1), costing `pytorch-model-recovery` and `tune-mjcf` a pass each. On the
  held-out tasks, two tasks were won and two lost, `code-from-image` by running out of time after twice
  the turns. jig doesn't know a task's time limit, so checking more can't be weighed against the time
  left.
- **No gain, more cost, so it stays opt-in.** Neither interval excludes zero, and the check cost 38% more
  on the original tasks and 65% more on the held-out ones (68% more on the in-house benchmark, where
  every task already passed).
- **mini-swe-agent stays a little ahead on fresh tasks.** On the held-out tasks it is 10 points ahead of
  jig without the check (0 to +25).

### Milestone 10: what mini-swe-agent's lead was made of

Milestone 10 looked for the cause of mini-swe-agent's lead by taking the differences between the agents
one at a time, first on the 20 held-out tasks (one attempt each, against `m8`), then on the original 20
(three attempts) to confirm. The answer turned out to be mostly not about either agent's design: both
agents sometimes fetched the benchmark's answers from GitHub, mini-swe-agent more often, and counting
those attempts as failed leaves a lead these runs can't tell from noise. Of the design differences,
neither jig's extra tools nor mini-swe-agent's prompts made a reliable one. The logs also showed three
bugs in jig's harness, now fixed.

```bash
export TASKS="$(grep -v '^#' eval/heldout.txt)"
eval/run.sh ho-jig-bash jig --ak tools=bash                    # jig with bash as its only tool
eval/run.sh ho-jig-mini jig --ak tools=bash --ak prompts=mini  # and with mini-swe-agent's prompts
unset TASKS
eval/run.sh tb-jig-mini jig -k 3 --ak tools=bash --ak prompts=mini   # the same on the original 20
python3 eval/report.py eval/results/ho-jig-m8.json eval/results/ho-jig-bash.json eval/results/ho-jig-mini.json eval/results/ho-mini.json
python3 eval/report.py eval/results/tb-jig.json eval/results/tb-jig-mini.json eval/results/tb-mini.json
```

| held-out 20, 1 attempt | passed | looked up | against `m8` | turns | cost |
|------------------------|--------|-----------|--------------|-------|------|
| jig `m8` | 70% (14/20) | 1 (passed) | | 23.1 | $0.033 |
| jig, bash only | 80% (16/20) | 0 | +10 points (0 to +25) | 20.9 | $0.036 |
| jig, bash only, mini-swe-agent's prompts | 85% (17/20) | 2 (passed) | +15 points (0 to +30) | 27.8 | $0.054 |
| mini-swe-agent | 80% (16/20) | 2 (passed) | +10 points (0 to +25) | 28.7 | $0.054 |

| original 20, 3 attempts | passed | looked up | against jig | timed out | errors | turns | cost |
|-------------------------|--------|-----------|-------------|-----------|--------|-------|------|
| jig (milestone 8's runs) | 68% (41/60) | 1 (passed) | | 4 | 2 | 22.9 | $0.049 |
| jig, bash only, mini-swe-agent's prompts | 63% (38/60) | 3 (passed) | −5 points (−15 to +5) | 9 | 4 | 31.4 | $0.084 |
| mini-swe-agent | 73% (44/60) | 7 (5 passed) | +5 points (−3 to +15) | 6 | 1 | 33.9 | $0.080 |

- **Both agents looked up the answers.** Now and then the model went looking for the task itself:
  searching the web for the task's name, its instructions in quotes or mini-swe-agent's submit command,
  then fetching `solve.sh` and `test_outputs.py` from the benchmark's GitHub repositories. That happened
  in 14 of the 160 attempts that used mini-swe-agent's prompts, by either agent, and in 2 of the 180
  under jig's own (Fisher's exact test, p = 0.001). `mteb-retrieve`, whose instructions mention
  "terminal-bench", sent mini-swe-agent to the benchmark in all three attempts. Counting these attempts as
  failed, as [`eval/report.py`](eval/report.py) now does for every run, shrinks mini-swe-agent's lead on
  the original tasks from 12 points (+3 to +22) to 5 (−3 to +15), and on the held-out tasks from 15 to 10
  (0 to +25): more than half of what milestones 8 and 9 set out to explain.
- **jig's tools aren't the difference.** mini-swe-agent has only bash. With bash only (`--tools bash`),
  jig did no worse on the held-out tasks, and on Terminal-Bench its model ran bash for 81% of its calls
  anyway.
- **mini-swe-agent's prompts didn't carry over.** They present the task as a job to finish (reproduce,
  fix, verify, try edge cases, then submit, after which nothing more can be done), and with them jig
  worked like mini-swe-agent: on the held-out tasks it took as many turns, ended every task with the
  submit command and solved 85%, with one attempt each. Three attempts at the original tasks said otherwise:
  5 points below jig's own prompt (−15 to +5) and 10 below mini-swe-agent itself (−20 to −2), with 70%
  more cost and twice the timeouts. The prompts suit mini-swe-agent's harness, not jig's, and jig keeps
  its own.
- **Three bugs in jig's harness, all fixed:**
  - *Background jobs held commands open.* Commands that started something in the background timed out
    far more often than others: 22 of 55, against 19 of about 3,900. `cd app && server > log &` kept the
    command's output open (see [the design decision](#design-decisions)), so jig waited out the timeout, 2
    minutes unless the model set one, then killed the server along with the command. That cost 11
    attempts 2 to 5 minutes each. mini-swe-agent's harness has the same flaw, with a 30-second limit.
  - *A dropped connection ended the task.* Twice in the last run, DeepSeek's connection dropped in the
    middle of a reply, which the SDK doesn't retry. jig now asks again.
  - *The model's commands killed jig.* Twice in the last run, the model stopped programs by their command
    lines (`server.py`, `vm.js`), and jig's command line held the task, which named them. jig now sets its
    process title to `jig`, and the adapter passes the task on stdin (`jig -`). mini-swe-agent, which gets
    the task as an argument too, has the same exposure.

### Milestone 11: one model, two APIs

Milestone 11 gave jig a second API format, OpenAI-compatible chat completions. It reaches OpenAI, local
models through Ollama or vLLM, and DeepSeek's other endpoint, the one mini-swe-agent uses, which made it
possible to test milestone 10's last suspect. Today's jig ran on both of DeepSeek's endpoints, three
attempts at the original 20 tasks each, alternating one round of each so that whatever DeepSeek's service
did over the 12 hours fell on both alike.

```bash
eval/run.sh tb-jig-anthropic jig                   # one attempt per job, alternating: then
eval/run.sh tb-jig-openai jig --ak api=openai      # tb-jig-anthropic-r2, tb-jig-openai-r2, and so on
python3 eval/report.py eval/results/tb-jig-anthropic.json eval/results/tb-jig-openai.json eval/results/tb-mini.json
```

| original 20, 3 attempts | passed | looked up | against the Anthropic endpoint | timed out | errors | turns | cost |
|-------------------------|--------|-----------|--------------------------------|-----------|--------|-------|------|
| jig, DeepSeek's Anthropic-compatible endpoint | 68% (41/60) | 0 | | 4 | 0 | 21.9 | $0.048 |
| jig, DeepSeek's OpenAI-compatible endpoint | 67% (40/60) | 2 (passed) | −2 points (−10 to +7) | 3 | 0 | 21.6 | $0.050 |
| mini-swe-agent (milestone 8's runs) | 73% (44/60) | 7 (5 passed) | +5 points (−3 to +13) | 6 | 1 | 33.9 | $0.080 |

- **The endpoint makes no difference.** The same agent and model solved as much through either API, with
  the same turns, tokens and cost. The rounds moved together, 14, 12 and 15 passes on one endpoint and
  14, 12 and 14 on the other: the second round was harder on both, which is what alternating them was for.
- **Where that leaves mini-swe-agent's lead.** Today's jig is 5 points behind (−3 to +13) at 40% less cost,
  once look-ups count as failures. Neither the tools, nor the prompts, nor the endpoint accounts for that
  remainder, and three attempts at 20 tasks can't tell it from noise.
- **No agent errors in 120 attempts.** Milestone 8's runs lost two attempts to the grep bug, and milestone
  10's last run four to dropped connections and self-kills; with those fixes, none failed that way here.
- The two look-ups on the OpenAI endpoint (counted as failed) bring jig's own prompt to 4 in 300 attempts.

### Milestone 12: skills to install, write and measure

Milestone 12 starts the plan for a jig that improves itself (see the roadmap) with skills. jig can
install skills from wherever they are shared, write new ones with you, learn one from a session, and
measure whether a skill helps. The last matters most: a skill earns its place in every prompt only if
tasks go better with it.

- **Installing.** `jig skills add anthropics/skills/skills/skill-creator` fetched Anthropic's
  `skill-creator` (18 files) in 2.3 seconds through a sparse clone, listing its ten scripts and its license
  first; `--skill` took `mcp-builder` and `webapp-testing` out of the same collection. The lockfile records
  each one's folder and commit, so `jig skills update` saw they were up to date, and `remove` took one out.
- **Learning a skill from a session.** A scratch project, "acme", has a release procedure written down
  nowhere: three files hold the version and must agree, the changelog moves its `[Unreleased]` entries
  into a dated section, a script checks the result, and the release commit and annotated tag have set
  wordings. In a first session the user explained all that while asking for release 1.4.3, and jig did
  it. Then `jig skills learn` turned the session into a skill, `acme-release`: the steps with the exact
  strings, a check after each, and a list of pitfalls (a partial version bump, a heading that fails the
  check, a lightweight tag), plus three evals with starting projects of their own: a patch release, a
  2.0.0 release, and one where the version files had drifted apart.
- **Measuring it** ([`examples/learned-skill/`](examples/learned-skill) has the project, the skill and every run). `jig skills test acme-release --attempts 3` ran each eval three times with the skill
  and three times without it, each in a fresh project with a home directory of its own:

  | 3 evals × 3 attempts | with the skill | without |
  |----------------------|----------------|---------|
  | passed (check and expectations) | 9/9 | 0/9 |
  | check passed | 9/9 | 0/9 |
  | expectations met | 51/51 | 29/51 |
  | steps | 7.8 | 7.7 |
  | cost per run | $0.0037 | $0.0041 |

  Without the skill, jig did a plausible release that missed the project's own conventions: the tag's
  message in all nine runs, the commit message in six, the changelog's form in three, the version files
  in two. Those conventions were only ever in the first session, and the skill carried every one of them
  to the tasks after it. It loaded the skill in all nine runs, and the runs cost no more for it.
- **The first measurements found the harness at fault, twice.** At first every run failed, with the
  skill or without: the grader saw the diff against the agent's last commit, so a task that committed its
  work looked as if it had done nothing. With that fixed, the check passed in all nine runs with the skill
  and none without, but the grader still failed four runs with the skill, from what it couldn't see: the
  output of the script the agent ran, today's date (it took 2026-04-27 for today), and files a diff
  doesn't show because they didn't change. The grader now gets today's date, the files the task changed
  or the expectations name as they ended up, and the commands the agent ran with their output; tests
  cover both fixes. A model grader is only as good as its evidence, which is why `check` exists.

### Milestone 13: memory and context

Milestone 13 gives jig a memory across sessions, and lets it propose edits to a project's AGENTS.md:
the second piece of the plan, after skills, and under the same rule (jig proposes, you approve). The
measure is whether a later session goes better for what an earlier one left behind.

The memory benchmark ([`bench/memory/`](bench/memory), run by `node bench/memory.ts`) has three
scenarios. In each, the user says something once, in a first session, while asking for something else;
then `jig memory reflect --yes` keeps what it proposes; then a follow-up task, which doesn't mention it,
runs three times with what reflection kept and three times without it (`--no-memory`, and AGENTS.md as
it was), each graded by a check:

- **commit-style:** commit messages here are `<area>: <summary>`, lowercase, without a period. The
  follow-up fixes a bug and commits; nothing in the repository shows the convention.
- **vendor:** never edit `vendor/`, which is regenerated; patch behaviour in `src/compat.py`. The
  follow-up's bug is in the vendored code, the obvious place to fix it.
- **changes-log:** "in every project", log each change in `CHANGES.md` with the date. The follow-up runs
  in a different project, so only a user memory can carry it there.

| scenario | what reflection kept | with it | without |
|----------|----------------------|---------|---------|
| commit-style | a "Commit messages" section in AGENTS.md | 3/3 | 0/3 |
| vendor | a "Never edit `vendor/`" section in AGENTS.md | 3/3 | 0/3 |
| changes-log | a user memory (and an AGENTS.md note in the first project) | 3/3 | 0/3 |
| all | | 9/9 | 0/9 |

- **What was said once carried over every time.** Without it, jig did each task competently and missed
  the point: in one run it wrote "Fix off-by-one in page() so page 1 is the first page"; it fixed the
  vendored code, where the bug was; it logged nothing. With it, the same tasks took no more steps (5.9 against 6.2).
- **Reflection put each thing where it belonged.** It made the two project conventions sections of
  AGENTS.md, as the prompt asks for rules every agent should follow, and the preference stated for "every
  project" a user memory, which is what carried it into a project the first session never saw.
- **The first run measured the benchmark, not jig.** `vendor` failed with the memory as well as without,
  because checking the fixtures had left Python's bytecode caches in them: the runs committed them as part
  of the starting point, and every test run then "changed" `vendor/`. The runner now leaves caches out
  and has git ignore them; the scenario was rerun with the others.

The in-house benchmark wasn't rerun: with nothing remembered, a one-shot task's prompt and tools are the
same as in milestone 12 (the proposal tools come only in sessions and `jig memory reflect`).

### Milestone 14: jig changes itself, and a referee decides

Milestone 14 is the last piece of the plan: jig changing its own prompts, tools and loop. A skill or a
memory can be judged by reading it; whether a line in the system prompt helps can't be, so jig proposes
the change and a referee measures it, on tasks the change wasn't made from, before anyone is asked to
merge it ([`bench/evolve.ts`](bench/evolve.ts); the commands are under [Improving itself](#improving-itself)).

```text
baseline: the evolve suite, 3 attempts a task
 ├─ split by pass rate: 5 training tasks, 5 held out
 ├─ analysis of the training attempts (what failed, where the steps went) → causes
 └─ for each cause, a candidate: jig changes a copy of itself (src/, skills/) → branch evolve/<n>
     ├─ the referee, in the main checkout:
     │    only src/ and skills/ changed · no words from the tasks · jig's tests pass
     │    training tasks, then held-out ones: more solved in 80% of resamples, or as many for 15% less
     └─ bench/evolve/archive/<n>: the cause, the change, the runs, the verdict
          accepted: the branch waits for a person · rejected: the branch is deleted
```

**The suite.** [`bench/evolve/tasks/`](bench/evolve/tasks) has ten small Python tasks: eight are a
`SPEC.md` to implement exactly (durations, cron's next run, an INI parser, money, Roman numerals, URL
paths, semver ranges, templates) and two a change across a small project (add a field, rename a
setting), each with visible tests and hidden ones. It is simple on purpose, a first version to build the
loop on. A calibration run (26 of 30) found two checks at fault, a rule the spec didn't state and a test
that read too much into a paragraph, and both were fixed before the baseline. The baseline, today's
jig: 28 of 30 (93%), $0.0138 an attempt. (A correction from milestone 18: one of those passes, on the
held-out ini-config, came from an attempt that found the benchmark's own folder on the disk, read the
task's solution and ran its hidden tests. Counted as failed, as look-ups are on Terminal-Bench, the
baseline is 27 of 30. No verdict below changes: every candidate was rejected on the training tasks.)

**What a verdict was worth, before any candidate ran.** The referee was run on simulated candidates,
drawn from the baseline's own pass rates (shrunk toward its overall rate) and costs:

| a candidate that | accepted |
|------------------|----------|
| changes nothing | 0.2% (1.1% with costs half again as variable, and lower pass rates) |
| fixes both of the baseline's failed attempts | 0.5% |
| costs 15% less | 21% |
| costs 25% less | 57% |

Judged on point estimates instead (solve any more, or as many for 15% less), a change that does nothing
would have been accepted 11% of the time. With one failed attempt in each half, the suite can't tell a
fix from luck: it can confirm that jig got cheaper, not that it got better at the tasks.

**What the analysis found.** One model call ($0.005) over the training half's two failed attempts and
each task's longest passing one (tool calls, failed hidden tests, last message) named four causes:
verification that tries the spec's examples but not its rules (a range that was only an operator, `^`,
passed as valid); filling what a spec leaves open with a guess or npm's conventions rather than its own
rules; editing a line, rerunning everything, editing again (once rewriting a file with its own contents);
and searching git history, tags and remotes for the hidden tests.

**The candidates.** One per cause, each proposed by jig for about $0.02, each a line in the system
prompt:

| # | the change | training tasks: solved | cost | verdict |
|---|------------|------------------------|------|---------|
| 1 | "Exercise every rule the task states, not only the examples it gives — including the cases it says are invalid or must raise." | 13/15 (baseline 14/15) | ×1.05 | rejected |
| 2 | "When the task or a file states how something must work — a spec, a format, a docstring — that text is the authority …" | 14/15 | ×1.01 | rejected |
| 3 | "Batch related edits and verify once, not after each one; after a fix, re-run only the check that failed. Don't write the same content back to a file." | 15/15 | ×0.92 | rejected |
| 4 | "Work from the task as written … Don't hunt for the hidden tests that grade you." | 15/15 | ×0.99 | rejected |

None reached the held-out tasks. The four cost $1.00, almost all of it in scoring ($0.23 a training run).

**Then the baseline was run again, unchanged** (29 of 30, $0.0137 an attempt), and judged as if it were
a candidate. On the training tasks it solved as many as the first run for ×0.86 the cost, a point short
of the bar; on the held-out tasks it solved 15 of 15 against 14, which the referee, as it was, would
have accepted. The first run had been unlucky, and the candidates were measured against its luck: its
duration-parse attempts cost $0.0209 on average, the rerun's $0.0117, and every candidate's $0.0148
to $0.0165, whatever it changed. Against the rerun, the four candidates cost ×1.06 to ×1.22, candidate 3's
"8% less" included. Simulated with the baseline drawn as a sample too (from both runs), the referee as
it was would have accepted a change that does nothing 4% of the time against the first run, not 0.2%.

So the referee changed, in a way that only makes it stricter: the held-out tasks now need what the
training tasks need (one more attempt in fifteen isn't more), a candidate is compared with a baseline
run the analysis didn't see, and `calibrate` draws the baseline as well as the candidate. Against both
runs, a change that does nothing is now accepted 0.4% of the time, and one that costs 25% less 34%.

- **The loop works; this suite can't reward it.** Every candidate was general, small and passed jig's
  tests, and the referee rejected all four for reasons the record shows. On a suite at 93 to 97% there
  is little to gain, and one attempt in fifteen is 7 points either way; the next suite needs tasks jig
  solves half the time, and more of them.
- **A word check stops naming the tasks, not fitting the setting.** Candidate 4 tells jig not to hunt
  for "the hidden tests that grade you", which only means anything on a benchmark. No candidate named a
  task, and that one passed; a person reading the diff would not merge it.
- **The analysis found jig looking for the answers.** It spent steps on `git log --all`, tags and remotes
  in hopes of finding the hidden tests. Candidates now work on a copy with no history: until this commit
  the suite wasn't in the history to find, but from now on it is.
- **The proposer had to be told about its own sandbox.** The first candidate took 13 minutes and 25
  commands, most of them on seven tests that can't pass inside jig's sandbox (they start sandboxes of
  their own, or run `ps`, which it won't allow), and some reading the old benchmark, which its copy then
  still held. The loop now runs the tests in the candidate's sandbox first, in 5 seconds, and names those
  seven in the task; the next three proposals took about a minute each.

**The model.** jig doesn't train a model; it produces the data. Sessions now record the system prompt
and tools they were given, and `jig sessions export` writes them in the format of OpenAI's chat
fine-tuning (secrets blanked out, thinking left out, and an example whose messages are in an order a
trainer would reject left out too). `bench/export.ts` writes only attempts that passed their hidden tests: from the rerun, 29
examples, all valid, 23 messages on average. Training a model on them, and routing between models by
task, are left for later.

### Milestone 15: a suite that can tell a fix from luck

Milestone 14's suite could reward a cheaper jig but not a better one: jig solved 93 to 97% of it, and
the referee would have accepted a change that fixed every failure 0.7% of the time, about as often as
one that changed nothing (0.4%). Evolving needs tasks jig fails about half the time.
[`bench/evolve2/`](bench/evolve2) is that suite, 21 tasks, and `npm run evolve` uses it by default
(`--suite evolve` for the first).

**Harder tasks didn't make jig fail.** The suite was built in three rounds, each calibrated before the
next, with the benchmark's usual 40 steps:

| round | tasks | solved |
|-------|-------|--------|
| 1 | 16 tasks, denser than the first suite's: 14 specs to implement exactly (which paths a set of `.gitignore` rules ignores, a TOML subset, iCalendar recurrence rules, league standings with head-to-head ties, shift pay, JSON Patch, numbers in words, an expression evaluator, a cache with expiry, business days, a ledger, a text table, unit conversion, and the first suite's semver ranges), and two changes to a small package (six reported problems; money in whole cents, with new rules) | 14 of 16 (88%) |
| 2 | the same, with a second layer of rules in 13 of them: nested `.gitignore` files, TOML's multi-line strings and dates, Python's `and`, `or` and `if` in the evaluator, British number words and cheques, JSON Patch's `diff`, points deductions and shared positions, holidays and call-in pay, and smaller additions to six more | 30 of 32 (94%) |
| 3 | five new kinds: an order to build 200,000 targets in, within a time limit; an upload server that hangs for minutes (a regular expression that backtracks exponentially on long names, and a listing that is quadratic in the number of uploads); three problems a shop reported only by their symptoms; reminders an hour late since the clocks changed, and on the wrong days; and a new command for a bank's command line that must work like the others in every way the code shows | 10 of 10 |

Of the four failures, three were rules the spec stated and jig missed: a holiday rule that isn't a
string must raise `ValueError`, not `TypeError`; `BYDAY=+3WE` has a signed ordinal; `·` multiplies, as
`*` does. The fourth was the spec's fault: "at least two postings, unless they are all virtual" holds
for a transaction with no postings at all, which jig read literally and the hidden tests didn't. It was
reworded during the second calibration, which that run's fingerprint of the tasks, taken as it ended,
couldn't show; `bench/run.ts` now takes one as a run starts too, and records both if they differ.

More rules only made attempts longer (a median of 11.5 steps and $0.028 an attempt in round 2, twice
the first suite's): with 40 steps, this model reads a spec closely and tests its work until it passes.
It solves self-contained tasks of this size almost always, as the main benchmark had shown (60 of 60 in
every run since milestone 7).

**A step budget did.** The tasks stay as they are, and the suite limits jig's steps instead
(`bench/evolve2/suite.json`, which `bench/run.ts` reads; `--max-steps` overrides it, every run records
its limit, and the referee won't compare runs made with different ones):

| steps | solved | an attempt |
|-------|--------|------------|
| 40 | 40 of 42 (95%) | $0.024 |
| 10 | 19 of 21 (90%) | $0.021 |
| 8 | 15 of 21 (71%) | $0.017 |
| 6 | 32 of 42 (76%) | $0.017 |
| 4 | 22 of 42 (52%) | $0.014 |

The 40-step row is rounds 2 and 3, on the tasks the budgets ran on (the ledger's reworded rule aside);
8 steps solving fewer than 6 is noise, at one attempt a task. At 4 steps no attempt finishes on its
own: each is stopped after its fourth model call (whose tool calls still run) and graded on the files
as they are then. So what the suite measures is how much jig gets right in four model calls: whether
it finds the rules on its first reading, whether its first draft is right, and how few calls go on
looking around. That is narrower than solving the task, and a change could do better here by rushing
(writing before it has read) and worse with 40 steps. The referee only sees the budget, so a candidate it
accepts should be run with 40 steps before it is merged.

**The baseline**, run twice, as milestone 14 learned to: 36 of 63 attempts (57%), $0.014 each, and 28
of 63 (44%), $0.012. Of the 62 failed attempts, 32 hadn't changed a file when their four calls ran out:
they were still reading, checking `git log` or the Python version, or looking for a reference
implementation (npm's `semver`, the source of `tomllib`). The other 30 wrote code that failed hidden
tests. Per task, from both runs, in the halves the split made:

| task | kind | half | 40 steps | 4 steps |
|------|------|------|----------|---------|
| bank-statement | a command that works like the others | training | 2 of 2 | 0 of 6 |
| gitignore-match | spec | training | 2 of 2 | 4 of 6 |
| json-patch | spec | training | 2 of 2 | 6 of 6 |
| library-issues | bugs | training | 2 of 2 | 2 of 6 |
| number-words | spec | training | 2 of 2 | 2 of 6 |
| shift-pay | spec | training | 2 of 2 | 2 of 6 |
| shop-cents | refactor | training | 2 of 2 | 2 of 6 |
| text-table | spec | training | 2 of 2 | 6 of 6 |
| toml-subset | spec | training | 2 of 2 | 1 of 6 |
| unit-convert | spec | training | 1 of 2 | 4 of 6 |
| build-order | spec, performance | held out | 2 of 2 | 5 of 6 |
| business-days | spec | held out | 2 of 2 | 4 of 6 |
| expression-eval | spec | held out | 2 of 2 | 2 of 6 |
| inventory-bugs | bugs | held out | 2 of 2 | 2 of 6 |
| league-standings | spec | held out | 2 of 2 | 5 of 6 |
| ledger-balances | spec | held out | 1 of 2 | 2 of 6 |
| reminder-times | bugs | held out | 2 of 2 | 4 of 6 |
| rrule-dates | spec | held out | 2 of 2 | 3 of 6 |
| semver-range | spec | held out | 2 of 2 | 3 of 6 |
| ttl-cache | spec | held out | 2 of 2 | 5 of 6 |
| upload-hang | bugs, performance | held out | 2 of 2 | 0 of 6 |

Seventeen of the 21 tasks were solved at least once and failed at least once. The two never solved
are the two where getting started costs most: bank-statement has ten files to read, and in upload-hang
the calls went on reproducing the hang; in 11 of their 12 attempts no file had changed. The same jig
solved the training half 18 and then 11 times out of 30, and the held-out half 18 and 17 times out of
33: one run is not enough to judge by, which is why the referee resamples, and draws the baseline too.

**What a verdict is worth now.** Simulated as in milestone 14, from both baseline runs, drawing the
baseline as well as the candidate. A candidate that fixes a share of the failures turns each task's
pass rate p into p + share × (1 − p):

| a candidate that | first suite | this suite |
|------------------|-------------|------------|
| changes nothing | 0.4% | 2.0% |
| fixes a tenth of the failures | 0.3% | 8.1% |
| fixes a fifth | 0.3% | 22.5% |
| fixes a third | 0.4% | 44.8% |
| fixes half | 0.4% | 75.0% |
| fixes all of them | 0.7% | 100% |
| costs 25% less | 34.1% | 20.4% |

The referee is the same; what changed is that it has something to see. On the first suite nothing a
candidate did to the pass rate could be told from luck; on this one a change that fixes a third of
jig's failures is accepted almost half the time. A change that does nothing gets through more often
(2.0%), since pass rates near a half vary the most, and so a cheaper change that solves no more is
accepted less often (20%): it now solves fewer tasks than the baseline, by chance, about as often as
more.

**Checking the tasks.** Each task is written by a script in
[`bench/evolve2/make/`](bench/evolve2/make), which then checks it four ways: the starting code parses,
the hidden tests fail on it, they pass with the reference solution, and the project's own tests agree
with that solution. The first and the last checks were added after a starting file that didn't parse,
and a visible test that expected what only the buggy code produced, had got past the other two. Where
a real tool knows the answer, the hidden tests' expectations come from it:

| task | answers from | the reference solution agrees on |
|------|--------------|----------------------------------|
| gitignore-match | git itself (`git check-ignore`) | the tests' 135 cases, and 885 random layouts |
| toml-subset | Python's `tomllib` (blocked inside the tests, so a solution can't use it) | the tests' 98 documents, 64 of them invalid |
| rrule-dates | python-dateutil's `rrule` | the tests' rules, and 2,939 random ones |
| expression-eval | Python's `eval` | 17,498 random expressions |
| reminder-times | Python's `zoneinfo` | the tests' cases |

A tool can mislead as a reference, too. On macOS git matches without regard to case unless told
otherwise, and `git check-ignore abc/` says `abc/**` ignores the directory, which git itself, walking
a project, never does: the cases were made with case-sensitive matching and directories named without
the slash. dateutil counts a weekly rule's first week only from the rule's start, which decides what
`BYSETPOS` picks in it, so the spec allows `BYSETPOS` only in monthly and yearly rules. And the
random expressions differ from Python's only where the spec chose to (a function's arity is checked
before its arguments are evaluated). The time limits make a slow solution fail rather than hang:
`signal.alarm` for pure Python, and a subprocess with a timeout for the regular expression and the
listing, since a regular expression in C doesn't stop for an alarm. The original pattern took 8.2
seconds on a name of 31 characters and 131 seconds on 35; the reference rewrite accepts the same names
(`fuzz_names.py`: 100,000 random ones). The reference build order takes 0.13 to 0.3 seconds on 200,000
targets; the obvious recursive depth-first search fails 4 of the 8 hidden tests. Rerunning the 20
scripts wrote the same tasks, byte for byte (the 21st, semver-range, is the first suite's, copied).

**Cost.** $5.05 in all: $1.29 for the three calibrations, $2.09 for the four budgets and $1.67 for the
two baselines. Scoring a candidate's training run now costs $0.40 to $0.44, against milestone 14's
$0.23.

- **Difficulty had to be measured.** Every round was designed to be hard (rules that are easy to
  overlook, a performance target, a hang to find, conventions only the code shows), and each one was
  solved at 88 to 100%. What jig finds hard is not what looks hard: the failures were single overlooked
  rules, never a task it couldn't do.
- **The budget changes the question.** With 4 steps the suite asks how well jig works in few calls,
  which is worth asking, since every call costs time and money, but it isn't "can it solve the task".
  The analysis will see what the counts above show, that half the failures are still exploring when
  the budget ends, and the obvious candidate, "write the first draft sooner", is the change the budget
  rewards most and 40 steps might not.
- **Next: candidates.** `npm run evolve -- analyze` on the training half, then `run`, and anything the
  referee accepts run again with 40 steps.

### Milestone 16: the first change the referee accepted

Milestone 14's loop, on milestone 15's suite: an analysis of the baseline's training attempts, three
candidates, and the referee. It accepted one, its first, which was then measured in the ways the
referee can't measure, and left on its branch.

**First, the referee against the run it would meet.** The calibration's 2.0% is an average over the
baseline runs a candidate might be compared with. Candidates were to be compared with one run, the
second baseline, which had happened to solve 11 of the training half's 30 attempts (the first run
solved 18). Held fixed at that run, the simulation accepted a change that does nothing 9.0% of the
time: that run's bad luck would have been every candidate's gain, as the first run's was in milestone
14. So before any candidate ran, a third baseline was made (32 of 63, 51%), candidates are compared
with every baseline run the analysis didn't see, pooled, and `calibrate` also gives the rate against
those runs as they came out. Against the second and third runs, a change that does nothing was
accepted 4.4% of the time, and one that fixes a third of the failures 77%.

**The analysis** ($0.009) named four causes, the costliest first: reading crowds out the work (the
tree, every module, git history, interpreter versions, until the budget runs out); one large write
that is never run; a change across files that reaches only the files jig happened to read; and calls
spent on probes that say nothing. jig changed a copy of itself for each of the first three, for $0.04
to $0.05 each, all three times in the system prompt:

| # | the change | training tasks | held-out tasks | verdict |
|---|------------|----------------|----------------|---------|
| 1 | "Look before you act: read the task, then the files the change touches (grep, glob). Don't survey the whole project, its history or its environment, and don't guess about code you haven't opened." and "Land the whole change early: make every part of it in your first draft, then verify and fix. Don't leave part of the work for later." | 18 of 30 (60%), against 27 of 60 (45%) | 22 of 33 (67%), against 33 of 66 (50%) | accepted: ahead in 93% and 90% of resamples |
| 2 | candidate 1's first line, and in place of "Verify your work": "Land the whole change in your first draft, then keep a step to run it — the tests, or a short probe that exercises it — and fix what fails. Work you haven't run is not done." | 16 of 30 (53%) | | rejected: ahead in 70% |
| 3 | candidate 1's change, with "(including the callers, constructors, registrations and config it affects)" | 12 of 30 (40%) | | rejected: behind |

All three cost about what the baseline did (×0.98 to ×1.10 an attempt), and together they took 43
minutes and $1.83. Candidates 2 and 3 were told how candidate 1 had done, and both kept its change and
added to it, which makes candidate 3 a measure of the noise: candidate 1's change and a parenthetical,
it solved 12 of the training attempts where candidate 1 solved 18.

**What the referee can't see.** It judged candidate 1 at 4 steps, on the runs it happened to get, and
an accepted result is one selected for being good. So three more measurements:

| | candidate 1 | jig as it is |
|---|-------------|--------------|
| this suite, 4 steps, run again | 38 of 63 (60%), $0.0134 | 34 of 63 (54%), $0.0139: a fourth baseline, in the same hour |
| this suite, 40 steps | 41 of 42 (98%), $0.0217, 11.3 steps | 40 of 42 (95%), $0.0237, 11.6 steps: milestone 15's rounds 2 and 3 |
| the main benchmark, 40 steps | 59 of 60 (98%), $0.0042 | 60 of 60 (100%), $0.0044, in the same hour |

Run again, the gain shrank to 6 points (−11 to +24): none of it on the training tasks (17 of 30 for
both) and 12 points on the held-out ones. With 40 steps it did no harm on this suite and cost a little
less. On the main benchmark it lost one attempt in 60, on `stale-cache`, which jig as it is solved 3
times in 3 and earlier versions 15 times in 15: it changed a function to take the service instead of
the store, and the hidden tests call it with a store. One failure is too few to blame on the prompt,
though it is the kind of change a narrower look at a project could make. By task, from both of its
runs against all four baselines, it gained most on specs in one file (semver-range 6 of 6 against 5 of
12, shift-pay 6 of 6 against 6 of 12) and lost most on build-order (3 of 6 against 11 of 12, each
failure in the code that reports a cycle) and on a change across files (shop-cents 0 of 6 against 3 of
12): a pattern, at six attempts a task, not a finding.

**It stays on its branch**, `evolve2/1`. The gain that survived the rerun is small, its interval
crosses zero, and the line most likely to cost something wasn't measured where it would: "don't
survey … its environment" on Terminal-Bench, where jig works on machines it has never seen. Merging
it waited for that check, which it failed (milestone 17).

**Cost.** $5.85 by jig's estimates: $0.88 for the third baseline, $1.83 for the three candidates ($0.13
of it proposing them), and $3.13 for the checks (the rerun and its baseline $1.71, 40 steps $0.91, the
main benchmark $0.51). DeepSeek billed 19.5 CNY for all of it, about $2.70.

- **The referee did its job, and a verdict is still a lead.** It rejected two candidates and accepted
  one whose gain partly survived a rerun, and about half of the gain it measured was the luck of the
  runs it happened to judge. That is what a person deciding to merge needs to know, and why nothing
  merges a candidate on its own.
- **A false acceptance rate belongs to the runs a candidate meets.** Averaged over the runs it might
  meet, it was 2%; for the one run it would have met, 9%. `calibrate` now reports both, and with the
  unseen runs pooled the second is 3.7%, now that there are four baselines in all.
- **Candidates learn from the archive.** Later candidates see earlier verdicts, and these two built on
  the accepted change rather than testing their own causes alone: their results measure the
  combination.
- **Next:** candidate 1 against jig as it is on Terminal-Bench, before merging it; and if it is merged,
  new baselines, since every run so far is of jig without it.

### Milestone 17: the accepted change, on Terminal-Bench

Milestone 16's referee accepted candidate 1 on small Python tasks at a budget of 4 steps, and its line
most likely to cost something, "don't survey … its environment", hadn't been measured where jig works
on machines it has never seen. So candidate 1 and jig as it is ran on the original 20 Terminal-Bench
tasks, two attempts each, in alternating rounds (jig, candidate, candidate, jig: about 2.3 hours a
round), as in milestone 11:

```bash
eval/run.sh tb-m16 jig --ak ref=m16        # then tb-c1 and tb-c1-r2 (--ak ref=evolve2/1), and tb-m16-r2
python3 eval/report.py eval/jobs/tb-m16+tb-m16-r2 eval/jobs/tb-c1+tb-c1-r2
```

| original 20, 2 attempts | passed | looked up | against jig as it is | timed out | turns | cost | agent time |
|-------------------------|--------|-----------|----------------------|-----------|-------|------|------------|
| jig as it is (m16) | 78% (31/40) | 1 (passed) | | 3 | 24.9 | $0.055 | 5.5 min |
| candidate 1 (evolve2/1) | 62% (25/40) | 1 (passed) | −15 points (−28 to −5) | 3 | 21.9 | $0.050 | 5.0 min |

- **It cost Terminal-Bench 15 points, so it isn't merged.** Both rounds agreed: 16 and 15 passes for
  jig as it is, 13 and 12 for the candidate. It lost model-extraction-relu-logits (2 of 2 against 0 of
  2), dna-assembly, adaptive-rejection-sampler and chess-best-move, and gained on no task. It took
  fewer turns and tokens and cost 9% less, but solved less. Its branch is deleted; the change stays in
  the archive, `bench/evolve2/archive/1`, with the decision, which `npm run evolve -- list` shows.
- **What the evolve suite measures and what Terminal-Bench needs pull apart.** At 4 steps the suite
  rewards getting it right with little looking; on an unfamiliar machine, with a task to work out,
  looking is the work. A referee that measures only the first accepts changes that cost the second.
  The next evolve suite needs tasks where exploring pays, or a candidate must also pass Terminal-Bench
  before it is accepted.
- **Neither prompt stops look-ups.** Each agent fetched the benchmark's files once, both times on
  mteb-retrieve, and both times the attempt passed and counts as failed. In jig's, it first searched
  its own source for an expected answer, then GitHub's code search, then downloaded the benchmark's
  repositories.
- **jig as it is did better than milestone 11's jig**: 78% against 68% two days before (+9 points, +1
  to +18, paired by task), with more turns and tokens an attempt. jig has gained skills, memory and
  session records since, and DeepSeek's service may have changed as well; these runs can't say which,
  which is why the comparison above is paired and in alternating rounds.
- A network outage of about five minutes during the last round left one trace, a reply that broke off
  and that jig retried (chess-best-move, which passed).

The four rounds cost $4.20 by jig's estimates, in 9 hours 20 minutes.

### Milestone 18: the answers out of reach, and a cheaper check that didn't work

Milestone 17 showed that the evolve suite rewards changes that cost jig on Terminal-Bench, so this
milestone set out to build a suite where exploring pays, for the referee to check candidates on. Building
it turned up a problem with the benchmarks first.

**The answers were within reach.** jig's sandbox lets commands read anything on the machine, and the
benchmarks keep their hidden tests and reference solutions on the same machine. Every attempt since
milestone 1 was searched for commands that touched a task's folder or the repository: one did. In
milestone 14's first baseline, an attempt at the held-out ini-config searched the disk for a library,
found the benchmark's own folder, read the task's solution and ran its hidden tests, and passed (so that
baseline is 27 of 30, not 28; no verdict changes, see milestone 14). The runner also gave jig the task's
folder in an environment variable, TASK_DIR, meant for the task's own scripts. Now:

- jig has a setting for it, `hiddenPaths`: files and folders sandboxed commands can't read at all
  (Seatbelt refuses them; bubblewrap mounts an empty folder over each). It is useful outside benchmarks
  too, for `~/.ssh` and the like; the model is told that some paths are hidden, not which.
- Every benchmark run that starts jig writes the run's jig settings with the answers hidden
  (`bench/hidden.ts`): the repository's history, `bench/` (every suite's tasks and generators, and the
  other attempts' logs and sessions) and `eval/`. bench/run.ts, bench/memory.ts, and the proposer in
  bench/evolve.ts, which until now could have read the suite it was being judged on.
- TASK_DIR no longer reaches jig, and attempts' home directories moved out of `bench/` (to
  `.bench-homes/`, still outside the sandbox's reach for writing, which the injection tasks check).
- A test runs jig with a model that tries to read a task's hidden tests, and checks that it can't
  (without the setting, it could: checked by hand).

Versions of jig before this one ignore the setting, so a run of an older version (`--ref m12`, say) can
still reach the answers.

**The exploration suite.** [`bench/explore/`](bench/explore) has 14 tasks, written by scripts in
`bench/explore/make/` that check each one four ways, as in milestone 15, of two kinds. In ten, what the
agent needs isn't in the instruction but somewhere in the project: conventions spread over a registry, a
helper and a document; a vendored retry helper; a rounding bug reached only through plugins loaded by
name; three data formats that only the data files show; a failure only a log records; a discount that
only the git history holds (the task's setup.sh writes the history); a generated reference; a settings
system; a migration convention. In four, the project's own test is a special case and the spec asks for
more: a sampler checked at one parameter value and asked for six (two with two peaks), a rota whose
example week a fill in order manages, floors a few tiles long and a billion long, a diff of five lines and
one of 50,000 lines with repeated lines, where difflib isn't the shortest. Where a task leaves room, the
hidden tests were also run against a second, differently read solution.

**Would it have caught the change Terminal-Bench turned down?** Candidate 1, rebuilt from its archive on
a branch of its own, against jig as it is, at the benchmark's usual 40 steps:

| | jig as it is | candidate 1 |
|---|--------------|-------------|
| the ten tasks with information to find, 2 attempts | 20 of 20, 9.9 steps, $0.0057 | 20 of 20, 9.1 steps, $0.0055 |
| the four special cases, 3 attempts | 8 of 12, 434 s an attempt | 12 of 12, 227 s |
| Terminal-Bench (milestone 17) | 78% | 62% |

- **Information:** both found everything, the history and the log included. With tasks this size, the
  model looks wherever it needs to, whatever the prompt says about looking.
- **Special cases: the opposite of Terminal-Bench.** On the rota, jig as it is wrote reference solvers,
  counting and timing scripts of its own, ran into the commands' time limits three to six times an
  attempt, and ran out of the attempt's 15 minutes all three times; candidate 1 finished in about
  three minutes each time. On Terminal-Bench the same thoroughness is what solved
  model-extraction-relu-logits: jig as it is tried its method on four other random networks, while
  candidate 1 checked it on the one it had, declared success, and failed on the hidden one. (A first,
  larger rota ran both into the time limit, 1 of 3 against 0 of 3, so its weeks were made smaller.)

**So the exploration suite isn't a gate in the referee.** It would have passed candidate 1, and preferred
it. A cheaper stand-in for Terminal-Bench is only worth what its agreement with Terminal-Bench is, and
these tasks don't agree with it on the one change there is to compare. An accepted candidate is checked
on Terminal-Bench itself, as milestone 17 decided. The suite stays, checked in CI with the oracle and
noop agents, as a record and as a start for a better stand-in, which would need harder tasks and
Terminal-Bench's time limits.

**Cost.** $1.34 for the exploration suite's runs.

- **Check the harness before trusting a result.** The hole was found only because a new suite made me
  look at what the runner gives jig. One attempt in about 2,000 went looking; a model that searches the
  disk for a library will find whatever else is there.
- **A proxy has to be measured against what it stands for.** Each kind of task looked like Terminal-Bench
  in miniature, and neither reproduced its verdict: a check made cheap changes what it measures.
- **Thoroughness costs time, and time is limited.** jig's habit of building its own checks solves hard
  tasks and runs out the clock on others; a change that trims it could do better or worse depending on
  the time budget alone.

### Milestone 19: Terminal-Bench as the referee's last stage

Milestone 17 checked an accepted candidate on Terminal-Bench by hand, and milestone 18 found no cheaper
check that agreed with it, so that check is now part of the loop. `npm run evolve -- tbcheck <n>` runs a
candidate the referee accepted, and jig where it branched, on the 20 tasks in `eval/subset.txt`, in
alternating rounds (two by default: 80 trials), and records the verdict with the candidate
([`bench/evolve-terminal-bench.ts`](bench/evolve-terminal-bench.ts)).

- **The bar is the referee's, turned around.** On the evolve suite a candidate must be ahead in 80% of
  resamples to pass; on Terminal-Bench it fails if it is behind in 80% of them. Two attempts at twenty
  tasks can't confirm a gain, but they showed milestone 16's loss: on milestone 17's runs the check
  says "solved fewer Terminal-Bench tasks (63% against 78%, -15 points, behind in 99% of resamples)",
  and two identical runs pass. Look-ups of the benchmark's answers count as failures, as in the report.
- **Out of the peak hours.** Each round starts only when it can finish outside DeepSeek's expensive hours
  (weekdays 9 to 12 and 14 to 18), allowing 10.5 minutes a task (milestone 17's longest round took under
  8), so a full check runs over an evening and a night, or a weekend.
- **Breaks don't lose work.** Rounds already run are kept, and one cut short is resumed with Harbor's
  `job resume` (that path hasn't been needed yet): after a break, the command picks up where it stopped.
- **The branch comes back for it.** A candidate whose branch a person deleted is rebuilt from the archive
  for the check, and deleted again after.
- **A smoke test** (`--tb-tasks`, one round, on one task) ran end to end in three minutes for $0.009: both
  sides passed, and the verdict of a run on some of the tasks isn't recorded.

A full check costs about $4.20, as milestone 17's did. So far 1 of 7 candidates got this far.

### Milestone 20: a second round, against fresh baselines

Milestone 18 changed what the model sees in a benchmark run (one sentence: some paths are hidden), so
the baselines of milestones 15 and 16 were no longer runs of the jig a candidate branches from. A new
option names the runs candidates are compared with, `calibrate --compare-with`, and two fresh baselines
of today's jig became them. The proposer now also hears what happened to an earlier candidate after the
referee: candidate 1's result on Terminal-Bench, and the decision not to merge it. The round ran from
18:00, started by a script that waited for DeepSeek's peak hours to end.

**The fresh baselines came out low:** 28 and 27 of 63 (44% and 43%), against 44% to 57% for the four
before. No attempt touched a hidden path, and the failures look like the usual ones (text-table, solved
12 times in 12 before, lost one attempt to a bug in its totals and two that spent their four calls
reading and never wrote the table); whether that sentence costs anything at 4 steps, or this is the
runs' spread, two runs can't say. Against them as they came out, a
change that does nothing would be accepted 7.6% of the time, and one that fixes a third of the failures
77%: the first higher than before, because on the training half they solved only 37%.

**The candidates**, one for the cause no candidate had taken and two for causes taken before:

| # | the change | training tasks | held-out tasks | verdict |
|---|------------|----------------|----------------|---------|
| 4 | "Look once per question: skip a check whose answer wouldn't change what you do next, and settle how code behaves by running it, not by reasoning about it." | 37% against 37% | | rejected |
| 5 | candidate 1's advice ("read the task, then the files the change touches … land the whole change in your first draft"), but only when the step limit is 8 or less, with the limit stated | 53% against 37% | 55% against 50% | rejected: ahead in 64% of resamples |
| 6 | after every edit, the tool's result adds "Before you finish, run the tests or a short probe that exercises this change, and fix what fails." | 50% against 37% | 42% against 50% | rejected |

- **The held-out tasks did their job.** Two candidates beat the training half's low 37% by 13 and 16
  points, and neither carried over: the comparison runs' bad luck on the training half was their gain,
  and the held-out half, which the analysis never saw, didn't share it.
- **The proposer learned from the decision.** Told that candidate 1 was accepted but solved 15 points
  fewer Terminal-Bench tasks, candidate 5 kept that advice for tight step budgets only, so that runs with
  steps to spare (on Terminal-Bench, jig gets 300) would get jig's prompt as it is. Accepted, it would
  still have needed Terminal-Bench, and then a person: it fits jig to the benchmark's own setting.
- No candidate was accepted, so `tbcheck` had nothing to do. One candidate's summary had come out as
  its thinking about the summary (it counted the words), so the summary is now the reply's last such line.

**Cost.** $3.66: $1.48 for the two baselines, $2.18 for the three candidates.

### Milestone 21: new causes, from today's jig

The analysis had come from milestone 15's first baseline, before milestone 18 changed what the model
sees, and all four of its causes had been tried, two of them twice. So `analyze --from <label>`
diagnoses another run, and the split records which one (`analyzed`): `calibrate` and `score` refuse to
compare candidates with it, the bias milestone 14 found. The analysis read `baseline-m19a`, and
candidates were compared with `baseline-m19b` and a third fresh run, `baseline-m19c`, which solved 52%,
back in the usual range: milestone 20's 44% and 43% look like the runs' spread. Against those two runs
as they came out, a change that does nothing would be accepted 1.8% of the time, and one that fixes a
third of the failures 65%.

The new analysis ($0.007) named the same failures in other words: reading until the four calls run
out, listing the project instead of following the spec and tests, one large write with no steps left
to check it, and a change across files that misses the file the tests use. A candidate for each of the
first three:

| # | the change, in the system prompt | training tasks | verdict |
|---|-----------------------------------|----------------|---------|
| 7 | "Look before you act, but no further than the change needs: read the task, any tests that cover it, and the files the change touches, then write the change within your first few calls …" | 43% against 42% | rejected |
| 8 | "… read the spec or tests the task comes with first, and let their names and imports select the files to change, rather than surveying the project." | 40% against 42%, cost ×1.24 | rejected |
| 9 | "Verify your work: run the tests, the type checker or the program right after you change something (one reply can change a file and run the check, in that order), and spend the steps left fixing what it reports. …" | 37% against 42%, cost ×1.15 | rejected |

- **Against a fair comparison, a line of advice doesn't move the suite.** Of the nine candidates on
  evolve2, eight changed the system prompt, most of them about how to spend the four calls. Against runs
  that came out a little low on the training half (42%, where the seven baselines have averaged 47%,
  from 33% to 60%), these three were within 5 points of nothing. The larger gains before were luck:
  milestone 20's came against a pair that solved 37% of the training half, and milestone 16's candidate
  1, run again, solved 57% of it, as many as the baseline beside it. What jig gets right in four calls
  looks set by the model more than by advice about it.
- **What is left is outside the prompt.** The loop (candidate 6's reminder after each edit was the only
  change there, and it lost on the held-out tasks), the tools, or the model: routing between models, or
  training one on the passed sessions jig already exports.

**Cost.** $2.22: $0.78 for the third baseline, $1.43 for the three candidates.

### Milestone 22: the loop and the tools, not the prompt

After nine prompt changes, a round in which candidates may change only jig's loop and tools:
`npm run evolve -- run --target loop` tells the proposer so (the prompt was measured nine times, and
nothing held up), the referee rejects such a candidate if it touches `src/prompt.ts`, and a cause tried
in the prompt counts as new for it. Compared, as in milestone 21, with `baseline-m19b` and `-m19c`:

| # | the change | training tasks | verdict |
|---|------------|----------------|---------|
| 10 | on the last step, if nothing has been changed yet, the model gets only the tools that change files (`src/agent.ts`, and the model calls, which can now take a step's own tools) | 50% against 42%, cost ×1.15 | rejected: ahead in 74% of resamples |
| 11 | `read_file` lists the project files a file it reads imports | | rejected unread: its comment's example, `from table import render`, names a task's file |
| 12 | with a tight step limit, after an edit the loop runs the project's tests itself and adds what they print to the edit's result (a new `src/tools/tests.ts` finds the command) | 47% against 42%, cost ×1.10 | rejected: ahead in 67% |

- **Closer than the prompt, and still short.** The loop's two candidates came out 8 and 5 points ahead,
  where the last round's prompt lines were within 5 of nothing either way, but neither reached the bar:
  ahead in 74% and 67% of resamples, against the 80% needed, at 10 to 15% more cost. Candidate 10 is
  the kind of change that can only matter under a budget: a run with steps to spare almost never gets
  to its last step without having changed anything.
- **The word check is strict by design.** Candidate 11's example used the very names of a task's file
  and function, which the proposer can't have seen (its copy of jig has no benchmarks, and the sandbox
  hides them); it was rejected unread all the same, since the check can't tell a coincidence from a leak.
- **A proposal that ran out of steps** (candidate 12 used all 60 of its own) had no summary, and its
  last words, "Let me rename.", had become one: such a candidate's summary now says it was cut off.

**Cost.** $1.19 for the three candidates.

### Milestone 23: routing to a stronger model

After the prompt (milestones 20 and 21) and the loop (22), two levers were left: routing work between
models, and training one. Routing first. `--escalate <model>` has jig work with its model until a test
command it ran fails, and then hands the steps left to a stronger one, with the whole conversation: both
are made with the same system prompt and tools, and DeepSeek's endpoint takes flash's thinking blocks in
v4-pro's requests. A test run has failed when it exits non-zero or when the runner says so (`FAILED (`,
`2 failed`, `--- FAIL` and the like), since models pipe most test runs into `| tail -20`, which leaves
the exit code tail's. jig prints the stronger model's share of the tokens on a line of its own, the
`--stats` file records it, and `bench/run.ts` bills it at that model's prices. On a project with two
bugs, whose tests flash ran first, v4-pro took over at step 2 and fixed both.

**The trigger, checked before it was paid for.** `node bench/escalation.ts <runs>` reads the sessions
saved by runs already made, and applies the loop's own rule to every step:

| runs of jig as it was | attempts | failed | would have handed over | of those, passed anyway | failures it would have reached |
|-----------------------|----------|--------|------------------------|-------------------------|--------------------------------|
| evolve2, 4 steps: milestone 19's three baselines and this milestone's | 252 | 137 | 0 | - | 0 |
| evolve2, 6 steps (this milestone's) | 63 | 19 | 2 | 2 | 0 |
| evolve2, 6 to 10 steps (milestone 15's budgets) | 84 | 18 | 5 | 5 | 0 |
| evolve2, 40 steps (milestone 15's calibration) | 58 | 4 | 7 | 7 | 0 |
| the main benchmark, 40 steps (milestone 15) | 60 | 0 | 6 | 6 | 0 |
| Terminal-Bench: six jobs from milestones 9, 11 and 16 | 159 | 42 | 1 | 0 | 1 |

flash's failures are silent. Where a test run fails, flash puts it right itself (20 of the 21
attempts that would have handed over passed), and in 219 of the 220 failures no test run had
failed before the last step: with few steps the calls ran out before jig ran the tests, and with many,
as on Terminal-Bench, the test runs jig made passed, or it made none, and the hidden tests failed. A
router can only act on a failure it sees, so the escalation itself wasn't run on evolve2: its attempts
would have been flash's.

**The stronger model alone**, which bounds what handing work to it could do: deepseek-v4-pro on evolve2
at 4 steps, three attempts a task, beside a run of flash in the same hour:

| | solved | an attempt | a solved task | time an attempt | failures with no file written |
|-|--------|------------|---------------|-----------------|-------------------------------|
| deepseek-flash, 4 steps (four runs) | 115 of 252 (46%: 44, 43, 52 and 43%) | $0.012 | $0.026 | 50 s | 86 of 137 |
| deepseek-v4-pro, 4 steps | 33 of 63 (52%) | $0.059 | $0.113 | 167 s | 14 of 30 |
| deepseek-flash, 6 steps | 44 of 63 (70%) | $0.016 | $0.022 | 67 s | 6 of 19 |

- **A little better, for five times the cost.** v4-pro was 7 points ahead of the four flash runs (−8
  to +22), ahead in 80% of resamples, and solved as many as the best of them. It writes sooner (47%
  of its failures hadn't changed a file, against 63% of flash's), but isn't better at every task: it
  solved semver-range 3 times in 3 (flash 5 in 12) and expression-eval never (flash 6 in 12), and
  neither model has solved bank-statement or upload-hang, the two where getting started costs most.
- **Judged as a candidate, the referee would reject it.** On the training half v4-pro is 14 points
  ahead of the four flash runs (ahead in 90% of resamples), and on the held-out half level (0 points,
  48%; against the referee's own comparison runs, +12 and −2): the pattern of milestone 20's two
  rejected candidates. But v4-pro wasn't made from the training attempts, so a lead on one half and
  none on the other needn't mean a change fitted to the tasks it came from: with ten tasks a half, it
  is also what a small gain spread unevenly over the tasks looks like. Nor does the referee hold cost
  against a change: it passed a fivefold cost on the training half.
- **Two more steps are the cheaper lever.** With 6 steps flash solved 44 of 63 (70%): 17 points more
  than v4-pro with 4 (−2 to +35, ahead in 96% of resamples) for a quarter of its cost an attempt, and
  24 more than flash with 4 (+8 to +40), upload-hang included, which neither model had solved in four
  calls. A solved task cost less than with 4 steps ($0.022 against $0.026), fewer attempts being wasted.

Milestone 21 guessed that what jig gets right in four calls is set by the model more than by advice
about it. A stronger model moves it a little, for five times the cost; two more calls of the same model
move it three times as far, for a third more. Routing on a failure can only help where the cheap
model's failures show, and here they don't: a trigger for silent ones needs a check the model doesn't
make itself, such as a second model reviewing the change before jig finishes (milestone 9's `--check`
asked the same model).

**Cost.** $5.45: $3.72 for v4-pro, $0.74 and $0.98 for the two flash runs, and under a cent for the
smoke test.

### Milestone 24: a second model reviews the work

Milestone 23 found deepseek-flash's failures silent: it finishes sure it is done, and only the hidden
tests know otherwise. On Terminal-Bench that is most of them: of the 60 failed trials of jig as it was
(nine jobs since milestone 9), 46 ended with jig saying it was done, and 14 at the time limit. And they
repeat: filter-js-from-html failed `test_clean_html_unchanged` in all 10 of its failures, dna-assembly
`test_primers` in all 5, the kind of requirement a second reading of the task might catch. A trigger at
that moment reaches 46 failures, where milestone 23's reached 1.

`--reviewer <model>`: the first time the model stops, with steps left, a second model checks the work
against the task before the task ends. The reviewer is a subagent on its own model
([`src/review.ts`](src/review.ts)), with the subagents' tools and rules (it reads files and runs commands
that only print or list, so it can't change the work it judges, or fetch the benchmark's answers), 12
steps, and a prompt of its own: the task, the model's last message, and a log of what the run did (each
file change, and each command with its exit code and last line of output; reads left out). It starts its
reply with APPROVED, or with PROBLEMS: and the problems, which go back to the model, once, with a note
that the reviewer can be wrong. Out of steps, it is asked for its verdict on what it has checked; a reply
with no verdict, or a review that fails, leaves the work as it is. jig prints the verdict and the
review's share of the tokens on a line of its own, the `--stats` file records it, and `bench/run.ts`,
Terminal-Bench's adapter (`--ak reviewer=<model>`) and its report bill that share at the reviewer's
prices. `--check` (milestone 9: the same model asked to check its own work) and `--reviewer` don't go
together.

**The measurement**: jig against jig with deepseek-v4-pro as the reviewer, on the 20 tasks, one attempt
each, alternating at each task (jig first on odd tasks, the reviewer first on even ones), each task its
own Harbor job with its image pulled before and removed after, and every trial started only where it
could finish outside DeepSeek's peak hours. It took two tries:

- **The balance ran out** at 01:36 on the first night, and the driver went on through 18 tasks that
  failed within a minute each. Those trials were deleted. The driver, and now `tbcheck`, check the
  balance before a trial or a round, and stop when the API refuses one (`refusedByApi`); that trial
  runs again.
- **Three reviews in five gave no verdict**: the reviewer spent its 12 steps on commands plan mode
  refuses (python3, awk, `command -v`), and stopped. Its prompt now says which commands run, and out of
  steps it is asked for its verdict. The run started over with that reviewer; the first try's seven
  tasks are kept apart (`eval/results/tb-m24-*-r1.json`: 3 of 7 each).

| | passed | looked up | timed out | cost | agent time |
|-|--------|-----------|-----------|------|------------|
| jig | 14 of 20 (70%) | 1 (mteb-retrieve, counted as failed) | 2 | $0.051 | 5.0 min |
| jig with the reviewer | 15 of 20 (75%) | 0 | 2 | $0.123 | 6.7 min |

Five points ahead (−20 to +30), ahead in 59% of resamples and behind in 26%: no worse by `tbcheck`'s
rule, and nowhere near the 80% the referee asks of an improvement. What the reviews did, on the reviewer's
side: 18 trials got as far as a review (in two, the time ran out first); 16 were approved, and 14 of those
passed; one review sent problems back (filter-js-from-html, which still failed); and one gave no verdict,
even when asked (make-mips-interpreter).

- **No result changed because of a review.** The sides differ on five tasks, three the reviewer's side
  won (dna-assembly, headless-terminal, tune-mjcf) and two jig's (adaptive-rejection-sampler,
  model-extraction-relu-logits), and on none of them did a review send anything back: it approved what
  flash had done, or never ran. These are tasks jig solves only some of the time anyway (6, 7, 2, 5 and
  6 times in 11 in the nine earlier jobs), so the five points are the two runs' own variance.
- **The reviewer can't see these failures either.** Of the four failures it reviewed, it approved two
  (model-extraction-relu-logits, whose extracted matrix doesn't match; mteb-retrieve, which ranks the
  wrong document), gave no verdict on one, and caught one, whose fix didn't pass. What decides these tasks
  shows only when something runs, and the reviewer can only read; the problems a reading can find, flash
  had mostly not left. It raised no false alarm (all 14 trials that passed were approved), so it did no
  harm either; its approval was right 14 times in 16, against 14 in 18 for the reviewed trials as a whole.
- **It costs more than twice as much**, $0.123 a trial against $0.051 (a review $0.09, most of it v4-pro's
  thinking), and 1.7 minutes more. So `--reviewer` is there, measured, and off by default.
- **The API key reached the model once more.** In one trial of the first try (db-wal-recovery), the model
  printed `/proc/<pid>/environ` for the processes in the container, one of them the shell that started
  jig. jig keeps its key out of its commands' environment (milestone 6), but where everything runs as
  root, a command can read any process's. The key went only to DeepSeek, its own provider, and into the
  local log, since redacted. Keeping it out of reach needs a container that never holds it: a proxy
  outside it that adds the key to jig's requests.

A review that could run things would be another tool, and one that could change the work it judges.
Together with milestone 23, the two ways of bringing in a second model, at a failure and before the end,
found the same thing: on these tasks, what flash gets wrong mostly doesn't show in what either model can
read.

**Cost.** $5.08 at the table's prices: $3.48 for the two sides of the run, $1.40 for the first try, and
$0.20 for a smoke test on filter-js-from-html (where the reviewer sent back four problems with their
lines, and jig worked 16 more steps and still failed).

### Milestone 25: the key stays on the host

In milestone 24 a model, root in its task's container, printed `/proc/<pid>/environ`, and with it the API
key: jig keeps the key out of its commands' environment, but not out of the processes around them, and as
root in a container a command can read anything jig can. So the key no longer goes into the container.
[`eval/key_proxy.py`](eval/key_proxy.py) runs on the host, on 127.0.0.1 (containers reach it as
`host.docker.internal`, and nothing else on the network can): jig in the container gets a token of the run
instead of the key, and a `--base-url` pointing at the proxy, which checks the token, puts the key in its
place (`x-api-key` for the Anthropic API, a bearer token for the OpenAI one) and streams the reply back as
it comes. A request with any other token is refused before it reaches the provider, and a provider out of
reach is a 502. The adapter starts one proxy per Harbor job, and `--ak key_proxy=false` hands jig the key
as before. On the way, `--base-url` now reaches DeepSeek's Anthropic-compatible endpoint, which had
ignored it.

Checked three ways:

- **Tests** (`test/key-proxy.test.ts`): the token swapped for the key in both forms, any other token
  refused with the provider never called, a provider out of reach, and jig's own DeepSeek requests
  through the proxy to a stand-in provider.
- **A container** (node:24-slim) where jig, behind the proxy and on DeepSeek, was asked to print every
  process's environment and say which values look like API keys. It found `DEEPSEEK_API_KEY` and advised
  rotating it; its value was the token, and the key appeared nowhere in the output.
- **A Terminal-Bench trial through Harbor** (log-summary-date-ranges): passed, with
  `--base-url http://host.docker.internal:<port>/anthropic` in its command, and neither the key nor the
  token in any of the job's 15 files.

What a model can still do with the token is call DeepSeek through the proxy, from its container, while the
run lasts, which is what jig does there anyway.

**Cost.** Under a cent.

## Tests

```bash
npm test            # the tools, permissions, sandbox, snapshots, search, context, skills, memory, MCP
                    # (against a hand-written server), hooks, subagents, running headless (--add-dir,
                    # --stats, a hung API), benchmark metrics, the evolve referee and the copies candidates
                    # work in, exporting sessions, and the loop: no API calls
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

## Roadmap

- [x] **1. Core loop:** streaming, `read_file` / `write_file` / `edit_file` / `bash`, step limit, approval prompt
- [x] **2. Reliability:** `grep` and `glob`; read-before-edit; CRLF handling; edit errors that point at the nearest match; permission modes with read-only commands allowed; hideable thinking; the benchmark
- [x] **3. Context:** `AGENTS.md`; token tracking with automatic and manual compaction; sessions saved as JSON Lines, with `--continue` and `--resume`; fixes for the two problems the benchmark found; three new benchmark tasks
- [x] **4. Safety:** macOS sandbox (writes only in the project, no network); `plan` mode; allow and deny rules; snapshots and `/undo`; prompt-injection guidance; read-before-edit narrowed to overwrites; two prompt-injection tasks
- [x] **5. Extensions:** Agent Skills with progressive disclosure; MCP client over stdio (official SDK) with restart; `PreToolUse` and `PostToolUse` hooks; read-only subagents; parallel read-only tool calls; project trust; three benchmark tasks for the extensions
- [x] **6. Evaluation:** Terminal-Bench 2.0 through Harbor against mini-swe-agent on the same model, with success rate, cost and turns per task; ablations of effort, compaction and subagents; `--add-dir`, `--stats`, and a 2-minute API timeout with retry notices
- [x] **7. Linux and CI:** a bubblewrap sandbox on Linux with the same policy and tests as on macOS, and a clear reason when it can't run; GitHub Actions on Linux and macOS with Node 22 and 24; benchmark tasks checked in CI, which caught two task checks that only worked on Node 26
- [x] **8. npm package and error bars:** the `jig-agent` package (compiled JavaScript, `--version`, MIT license; CI packs, installs and runs it); three attempts per Terminal-Bench task with 95% intervals, which showed mini-swe-agent ahead by 12 points (+3 to +22) where one attempt had shown a tie (milestone 10 found that 5 of its passes were look-ups of the benchmark's answers: without them, +5, −3 to +15); a grep memory bug those runs found, reproduced and fixed
- [x] **9. Checking before finishing:** a diagnosis of jig's failures (most were confident early finishes), `--check` to make one-shot runs verify against the task, measured on the original tasks and on 20 held-out ones: it fixed the failures it aimed at but ran others out of time, so it is opt-in
- [x] **10. What mini-swe-agent's lead was made of:** experiments one difference at a time, on held-out tasks and then three attempts at the original ones (`--tools`, `--system-prompt`, mini-swe-agent's prompts through the adapter); the finding that both agents sometimes fetched the benchmark's answers, now counted as failures, which shrank mini-swe-agent's lead from 12 points to 5, within the noise; neither jig's tools nor mini-swe-agent's prompts made a reliable difference; three harness fixes: background jobs that held a command open, replies that broke off, and models killing jig through its command line (`jig -` reads the task from stdin)
- [x] **11. One model, two APIs:** an OpenAI-compatible API (`--api openai`, `--base-url`) for OpenAI, local models through Ollama or vLLM, and DeepSeek's chat completions endpoint, translated at the edge so the rest of jig is unchanged; today's jig on both of DeepSeek's endpoints, in alternating rounds: no difference (−2 points, −10 to +7), and no agent errors in 120 attempts
- [x] **12. Skills to install, write and measure:** `jig skills add/list/update/remove` from folders and git repositories, with a lockfile; the bundled `skill-writer`, `jig skills new` and `/skills new`, `jig skills learn` and `/learn`, all through `propose_skill`, which shows you the skill and saves it only where you say; `jig skills test`, each eval with and without the skill; a skill learned from one session passed 9 of 9 eval runs with it, against 0 of 9 without
- [x] **13. Memory and context:** user and project memories under `~/.jig/memory/`, indexed in the system prompt and read with the `memory` tool; `propose_memory` and `propose_instructions` (AGENTS.md edits as diffs), approved one at a time, secrets refused; `/remember`, `/reflect`, `/memory` and `jig memory list|show|remove|reflect`; `--no-memory`; the memory benchmark: a convention or preference said once, in an earlier session, was followed in 9 of 9 later runs with what reflection kept and 0 of 9 without
- [x] **14. jig changes itself, under a referee:** `bench/evolve.ts`: an analysis of jig's own attempts on a new ten-task suite, candidate changes jig makes to a copy of itself (no benchmarks, no history, its own sandbox and home), and a referee in the main checkout (changed files, task words, jig's tests, training then held-out tasks, a bootstrap over tasks and their attempts) whose false acceptance was measured before any candidate ran (0.2%); four candidates for the four causes found, all rejected on the training tasks, the best solving 15 of 15 for 8% less; a second run of the unchanged baseline, which the referee as it was would nearly have accepted, showed that saving to be the first run's bad luck and the 0.2% to be 4% against that run, so the held-out tasks now need what the training ones do, candidates are compared with a run the analysis didn't see, and the simulation draws the baseline too (0.4%); sessions record their system prompt and tools, and `jig sessions export` and `bench/export.ts` write them as fine-tuning data, the latter only attempts that passed their hidden tests
- [x] **15. A suite that can tell a fix from luck:** `bench/evolve2`, 21 tasks written by scripts that check each one four ways (it parses, fails as given, passes with the reference solution, and its visible tests agree with that solution), with the hidden tests' answers from git, `tomllib`, dateutil, Python's `eval` and `zoneinfo` where a tool knows them; denser specs (88%, then 94%) and five new kinds of task (10 of 10) didn't make jig fail with 40 steps, and a budget of 4 steps did (57% and 44% in two baseline runs), set per suite in `suite.json` and recorded with every run; against it, the referee accepts a change that fixes a third of jig's failures 45% of the time, where on the first suite it couldn't tell such a change from luck (0.4%), and a change that does nothing 2.0%
- [x] **16. The first change the referee accepted:** before any candidate ran, the false acceptance against the one baseline run candidates would meet turned out to be 9%, not the 2% averaged over runs, so candidates are compared with every run the analysis didn't see, pooled, and `calibrate` reports the rate against those runs (3.7% with four baselines); the analysis found jig reading until its 4 steps ran out, and of three prompt changes the referee accepted one (+15 and +17 points); run again beside a fourth baseline it was +6 (−11 to +24), harmless with 40 steps (41 of 42) and one attempt short on the main benchmark (59 of 60), so it waits on its branch for a Terminal-Bench check
- [x] **17. The accepted change, on Terminal-Bench:** candidate 1 against jig as it is on the original 20 tasks, two attempts each in alternating rounds: 62% against 78%, −15 points (−28 to −5), both rounds alike, so it isn't merged; the evolve suite rewards getting it right with little looking, which Terminal-Bench doesn't; each prompt looked the benchmark up once; jig as it is solved 9 points more than milestone 11's jig (+1 to +18)
- [x] **18. The answers out of reach:** an attempt in milestone 14 had found its task's folder on the disk and run the hidden tests (that baseline is 27 of 30, not 28; no verdict changes), so jig gets `hiddenPaths`, which its sandbox hides from commands, every benchmark run hides the tasks, logs, `eval/` and the history with it (`bench/hidden.ts`), and TASK_DIR no longer reaches jig; `bench/explore`, 14 generated tasks where exploring pays (information to find, or a visible check that is a special case), which didn't reproduce Terminal-Bench's verdict on milestone 16's candidate (20/20 against 20/20, then 8/12 against 12/12, the candidate ahead), so it isn't a gate in the referee
- [x] **19. Terminal-Bench as the referee's last stage:** `npm run evolve -- tbcheck <n>` runs an accepted candidate and jig where it branched on the 20 Terminal-Bench tasks in alternating rounds, starts each round only when it can finish outside DeepSeek's peak hours, picks up after a break, and records the verdict (rejected when behind in 80% of resamples: milestone 17's runs give -15 points, rejected); a smoke test on one task ran end to end
- [x] **20. A second round, against fresh baselines:** `calibrate --compare-with` names the runs candidates are compared with, and two fresh baselines of milestone 19's jig became them (44% and 43%, against 44 to 57% before); the proposer hears what Terminal-Bench and the person decided about earlier candidates; three candidates, all rejected, two of them after beating the training half by 13 and 16 points, on the held-out tasks (one was candidate 1's advice, kept for tight step budgets only)
- [x] **21. New causes, from today's jig:** `analyze --from <label>` diagnoses another baseline run, and the split records it so that candidates are never compared with the run the analysis saw; a third fresh baseline (52%); the new analysis named the same failures in other words, and its three candidates came out within 5 points of nothing against a fair comparison: across nine candidates, a line of advice in the prompt hasn't moved what jig gets right in four calls
- [x] **22. The loop and the tools, not the prompt:** `run --target loop` lets candidates change only the loop and tools (the referee rejects one that touches the prompt); three candidates: forcing a change on the last step if there is none (+8 points, ahead in 74% of resamples), running the tests after each edit under a tight limit (+5, 67%), and one rejected unread by the word check; closer than the prompt's, short of the 80% bar
- [x] **23. Routing to a stronger model:** `--escalate <model>` hands the steps left to a stronger model once a test run fails (by the runner's report too, since `| tail` hides the exit code), its share of the tokens printed, kept in `--stats` and billed by `bench/run.ts`; `bench/escalation.ts` checks a trigger on saved sessions before it is paid for: in 676 attempts of jig as it was it would have reached 1 of 220 failures (flash's are silent) and handed over 21 times, all but one on attempts flash put right; deepseek-v4-pro alone at 4 steps: +7 points (−8 to +22) for five times the cost, ahead on the training half and level on the held-out one, so the referee would reject it; flash with 6 steps: 70%, 17 points more than v4-pro with 4 for a quarter of the cost
- [x] **24. A second model reviews the work:** `--reviewer <model>`: the first time the model stops, a read-only subagent on another model checks the work against the task, and its problems go back once; on Terminal-Bench, deepseek-v4-pro reviewing flash's work: 75% against 70% (+5, −20 to +30) for 2.4 times the cost, and no result changed because of a review (16 approvals, 2 of them of failures; 1 problem report, not fixed); the reviewer can't see what only running shows, and it stays off by default; `tbcheck` now stops when the balance is low or the API refuses a trial, which runs again
- [x] **25. The key stays on the host:** Terminal-Bench's containers get a token of the run, and `eval/key_proxy.py` on the host (127.0.0.1, reached as `host.docker.internal`) swaps it for the API key and streams the reply back; a model asked to print every process's environment found only the token; `--base-url` now reaches DeepSeek's Anthropic-compatible endpoint

## License

MIT, see [LICENSE](LICENSE).
