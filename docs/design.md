# Design decisions

Why jig is built the way it is, one decision at a time. The [README](../README.md) has the overview.

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
  `INVALID_JSON` instead of running it: the parser's error, with its position, and the input's start and
  the text just before the error, not all of it, since a reply that ran to its output limit can leave a
  call of 100k characters (milestone 27).
- **Only the tools a request declared run.** A model can call a tool it wasn't offered (milestone 28), so
  each model call reports the tools its request declared, and the loop refuses a call to any other.
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
  `--die-with-parent` takes the sandbox down if jig dies. Commands keep the machine's process IDs, so
  they can signal the user's other processes: in a PID namespace of their own (`--unshare-pid`), a job a
  command leaves in the background would die with its shell, which the rule above leaves running. And
  `--unshare-net` cuts off IP only: a daemon listening on a Unix socket (Docker's, say) stays within
  reach, and closing that would take seccomp.
- **The file tools confine themselves.** They run in jig's own process, where the sandbox doesn't reach,
  so they check paths themselves: against the project and the `--add-dir` directories, and a change
  again by where its path really leads. Without that, a symlink (a cloned repository can carry one, a
  command can make one) let an audit's edit reach `~/.bashrc`, with no question in `edits` mode.
  Reading still follows links out, since commands can read anything anyway; refusing would protect only
  the hidden paths, which are checked by real path instead, and would break linked packages. A git
  directory's `config` and hooks are never changed, since git runs the programs they name outside the
  sandbox.
- **jig's own git runs none of a repository's programs.** `grep` and `glob` run `git ls-files` in jig's
  own process, and git runs `core.fsmonitor` on every one: in an audit, a sandboxed
  `git config core.fsmonitor` ran a program as jig on the next search, and it copied the API key. So jig
  runs git with fsmonitor and hooks turned off and without its API keys. The sandbox also keeps the
  project's git config and hooks read-only, and its git directory in place, for the user's own git after
  the session. That can't cover every way: a command can still point git at another git directory (a
  `commondir` file does) or make a repository of its own, so jig's git doesn't rely on it.
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
  cost (see [milestone 9's results](milestones.md#milestone-9-checking-before-finishing)), so it is off by default.
- **A review that runs the work runs it in a copy.** A reviewer that only reads can't see what only
  running shows (milestone 24's approved two such failures), and one that runs things can change what it
  judges: a test that writes a cache, a server it leaves running, a file it "fixes". So `jig review` runs
  its commands in a copy of the machine, made when the agent is done (on Terminal-Bench a sibling
  container from `docker commit`, with no network and none of Harbor's mounts), through a prefix spawned
  without a shell. A problem must come with the command that shows it and what that printed, and the
  command runs again in a fresh copy before the problem goes back, so the model gets evidence it can
  check rather than a claim. And what a review did is measured in the trial it happened in: the hidden
  tests run on the work as the review saw it, beside the trial's own result after the fix.
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
  in [`src/openai.ts`](../src/openai.ts), and its reply is translated back into the Messages API's blocks, so
  the agent loop, sessions, compaction and tools don't know which API they ran on. Thinking goes back as
  `reasoning_content`, which DeepSeek requires on every earlier reply once tools are declared; each tool
  result becomes a `tool` message right after its call; cached tokens, which the chat API counts inside
  the prompt, are counted apart as on the Messages API. Claude stays on the Messages API.
