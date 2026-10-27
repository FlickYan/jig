# Design decisions

Why jig is built the way it is, one decision at a time. The [README](../README.md) has the overview.

- **Exact-string edits.** `edit_file` replaces `old_string` only if it occurs exactly once, counting
  overlapping matches. Line numbers go stale after the first edit, and whole-file rewrites are slow, cost
  output tokens and can silently drop code. The replacement is spliced in by index: `String.replace` would
  expand `$&` and `$1` inside the new code.
- **Errors are written for the model.** A failed tool call returns an error that says how to fix it. When
  `old_string` doesn't match, jig looks for the nearest thing in the file: leftover line numbers from
  `read_file`, the same lines with different indentation (shown exactly as they are), failing that the
  same text with other spacing, even within a line, or where its first line appears. Where it is only
  part of a line, the error shows just that part: told to copy the whole line, a model that kept
  `new_string` to the part would delete the rest. Lines shown only for context are cut as `read_file`
  cuts them, so one line of minified code can't fill the conversation. When it occurs more than once, the
  error says on which lines. The next attempt usually succeeds.
- **Read before overwrite.** jig remembers each file's modification time and size as of the model's last
  read (`read_file`, or printing it with `cat`, `head` or `tail`). `write_file` refuses to replace a file the
  model hasn't read, or one that changed since (a formatter, a command or the user edited it), so it never
  overwrites work it hasn't seen. `edit_file` doesn't need the check: its exact, unique match already proves
  the model knows the text it replaces. In M2 and M3 the check covered edits too, and in the benchmark it
  refused 22 edits, all false alarms, so M4 narrowed it.
- **Line endings are the file's business.** The model writes `\n`; in a file that uses `\r\n`, edits are
  matched and written with `\r\n` (including lines an edit adds), and `write_file` keeps an existing file's
  CRLF endings. Encodings are not converted: `edit_file` and `write_file` change only UTF-8 files.
  Decoding a Latin-1 file as UTF-8 and writing it back turned each `é` in it into `�`, also in lines the
  edit never touched, and writing in the file's own 8-bit encoding would mean guessing which one it is. So
  for those, and for UTF-16, the error says to use a command.
- **Search that respects `.gitignore`.** `grep` and `glob` list files with `git ls-files` when the project
  is a git repository (so ignored files are skipped for free), and walk the directory otherwise. They are
  plain Node, with no dependency on ripgrep being installed. Everything git tracks is listed, and a nested
  repository (a submodule, a clone) through its own git; the built-in list of directories not worth
  searching (`node_modules`, `build`, `target`, ...) is only for what git doesn't track. A path that git
  ignores, and tracks nothing in, is walked when the model names it (`grep` in `node_modules/pkg`): git
  lists nothing there, and grep said "No matches." for text that was in it. Only `.git` is skipped in it,
  since most packages keep their code in `dist/` or `build/`; the project itself, which a home directory's
  git may ignore whole, still skips the list. A search cut short of the file list says so: `grep` reads
  20,000 files at most, the first by name, and a walk outside git stops there too. The cut used to be
  silent: in a large repository, grep said "No matches." for code that was there. Binary files and files
  over 5 MB are still skipped without a word. `grep` matches in a worker thread that Ctrl+C stops, as do 30
  seconds on one file: a regular expression can take exponentially long on some lines, and in jig's own
  thread nothing can stop it. The limit is for one file because a whole search can take that long just
  reading, from a cold disk in a fresh container.
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
- **Compaction replaces the history; it never edits it.** The summary request repeats the last request with
  one extra message, and allows no tool call (`tool_choice: none`). For Claude, that change keeps only the
  tools and the system prompt in the prompt cache: the history is written to it again. Afterwards only the
  summary is sent: keeping the last few turns verbatim would replay thinking blocks whose earlier history
  is gone, which the API can reject, and a fresh start is valid for every provider. A request the user just
  typed is kept word for word after the summary, and the model must read a file again before `write_file`
  replaces it. Mid-task, the task is restated after the summary, word for word up to 20,000 characters (a
  longer one by its start and its end, since what it asks for is often last), with the log of file changes
  and commands a reviewer gets, since a summary keeps the conclusions, not the working state (milestone 6).
- **The API says when the conversation is too long.** jig doesn't know every server's window, so it
  doesn't compact before a request that won't fit (milestone 28); when the API rejects one as too long,
  by one of a few specific wordings, it compacts and makes the call again, once. The summary request is
  the history plus one message, so it would be rejected as well: it gets a copy whose tool results are
  cut to their start and end, the oldest first, until it is 0.7, then 0.5, of the size (`/compact` does
  this once its whole request is rejected). The copy is only sent; the history is still replaced
  whole. Past `--compact-at`, a summary that fails doesn't end the task, since the conversation may
  still fit: it goes on as it is, and compaction waits 3 steps before it is tried again.
- **Every tool call gets a result.** Even calls that never ran (declined, interrupted, cut off at
  `max_tokens`, invalid input) get an error result, so the next request is always valid.
- **Only a reply with something in it joins the history.** A reply with no text and no tool call (empty,
  or only thinking) would be an assistant message the API rejects in every later request. It is left out,
  and a note after the last user message asks the model to go on: two user messages in a row, which the
  Messages API merges into one turn, as with compaction's summary request.
- **Commands run in their own process group.** A timeout or Ctrl+C kills the whole group, so a test
  runner's worker processes die too. So does jig's exit, which closing the terminal (SIGHUP) and a plain
  `kill` (SIGTERM) bring about too: the group is a session of its own, which closing the terminal doesn't
  reach, so without bubblewrap's `--die-with-parent` a command ran on after jig was killed. Without it, one
  still does after a `kill -9`, which jig can't catch. Commands get no stdin, so an interactive prompt gets
  end-of-file instead of hanging the agent.
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
- **The file tools confine themselves.** They run in jig's own process, where the sandbox doesn't reach, so
  they check paths themselves: against the project and the `--add-dir` directories, and a change again by
  where its path really leads. Without that, a symlink (a cloned repository can carry one, a command can
  make one) let an audit's edit reach `~/.bashrc`, with no question in `edits` mode. Reading still follows
  links out, since commands can read what they lead to as well, and refusing would break linked packages.
  What the sandbox hides from commands the tools refuse by real path instead, with the sandbox off too: the
  hidden paths, and jig's own directory but for its skills (in a review, `read_file` and `grep` read
  another project's session through a link a command made to it; the `skill` tool's files go the same
  way, and so does finding skills, or a `SKILL.md` linked to another project's memory would put its name
  and description in the next session's catalog). Its skills they read but don't change, as commands
  can't: in a home-directory project, `write_file` could plant one that every later session offers. But
  skills linked out of it they change where the link leads, as commands can: refusing them there stopped
  edits to skills kept in a dotfiles repository. A
  `.git` directory's `config` and hooks, and the files that say where they are, are never
  changed, since git runs the programs they name outside the sandbox. The tools know a git directory by
  that name, and by what the sandbox locks, worked
  out once a session whether there is a sandbox or not: in a review, `write_file` put a hook in one made
  with `--separate-git-dir` in the project, which commands couldn't change. One by another name that a
  command makes during the session is changed like any other file. Some of jig's own
  writes into the project are held to the same: in an audit, a command's `ln -sf` sent the `--stats` file
  and an approved AGENTS.md edit to a file outside it. Those edits and the skills the model writes now go
  by real path, and the stats file, rewritten all through a run, is written anew and renamed into place,
  since a rename replaces a link where a write follows it (a linked folder on the way to it is still
  followed). A path in `/dev` or `/proc`, such as `/dev/stdout`, is still written to: jig can't make a file
  there, or as root would replace `/dev/stdout` with one, and no sandboxed command can put a link there.
  That goes by where the path is, not by what is there: a job an earlier run left in the background can
  leave a link to a device, or a named pipe, anywhere else it can write. So a named pipe elsewhere is
  replaced too. The project's skills lockfile is written the same way: jig reads it before it rewrites it,
  and a named pipe a job left in the background put there in between would have had jig wait for good.
  The user's own is written through a link: commands can't write jig's directory, and the rename replaced
  a link to one kept in a dotfiles repository, which then stopped getting updates. An approved AGENTS.md
  edit, written once the user has read the diff, isn't renamed into place either, as a link from AGENTS.md
  to CLAUDE.md is how some projects keep one file: it is written to a file opened without waiting and
  checked to be a regular one, so a named pipe made there meanwhile is refused. What
  jig reads from the project to work in it (AGENTS.md, skills, the settings, the git
  files the sandbox watches, the skills lockfile and the installed skills' files) it opens only if it is a
  regular file, without waiting: in a review, a command's `mkfifo .git`, where jig ran in a subdirectory,
  had jig wait after the task until it was killed, and a link to `/dev/zero` read without end; a
  `mkfifo .jig/skills-lock.json` did the same to `jig skills list`. `jig skills add`, `update` and
  `remove` go by real path in the project as well, and refuse a name in the lockfile, which commands can
  write, that isn't a skill's name: a name of `../..` made `remove`
  delete the project. Nor do they, or a skill the model writes, change anything in a `.git` directory: each
  replaces a skill's folder whole, while the file tools' check for `config` and hooks looks at one file,
  and in a review, `.jig/skills` linked to `.git/modules` let `update` put a skill's files in place of a
  submodule's config. Nor what the sandbox locks in a git directory by another name, or a folder holding
  it: they knew one only by the name `.git`, and with `.jig/proposals/skills` linked into one made with
  `--separate-git-dir`, a proposal could replace its hooks, or the whole of it. `update` skips an entry it
  refuses, or can't fetch or install, updates the rest and exits non-zero: one entry a command wrote, with
  a bad name, a missing path or no fields at all, used to
  stop it before the user's own skills. An entry can also point anywhere, and its question named only the
  skill: it now names the URL or folder, a folder in the hidden paths (or holding one) is refused, since
  its files would land where commands can read them, and only https, ssh and file URLs are fetched, since
  git runs a program for some others (`ext::`, which jig keeps refused whatever git's config says). In a
  review, a file URL to a hidden repository still brought its files in: such a repository is now refused
  too, read from the URL as git reads it (decoded, without its host), and every path goes by the system's
  real path (Node's takes `link/..` for the folder holding the link). And with paths hidden, git reads a
  file URL's repository in the sandbox, since a `.git` file or the alternates there can lead it to a
  hidden one. `add` refuses and fetches the same way: it installed a skill from a hidden folder without
  a word, which every later `update` then refused.
- **jig's own git runs none of a repository's programs.** `grep` and `glob` run `git ls-files` in jig's own
  process, and git runs `core.fsmonitor` on every one: in an audit, a sandboxed `git config core.fsmonitor`
  ran a program as jig on the next search, and it copied the API key. So jig runs git with fsmonitor and
  hooks turned off and without its API keys. The sandbox also keeps read-only, for the user's own git after
  the session, the repository's git config and hooks and its submodules', and the files that point git at a
  git directory (every worktree's and submodule checkout's `.git` file, and every worktree's `commondir`,
  not only the one jig runs in: the user runs git in the others too) or add config (`config.worktree`); and
  the directories holding them in the git directory in place, since one moved aside could be replaced. So
  `git worktree remove`, and `git rm` or `git mv` of a submodule, fail in the sandbox for one that was
  there when the session began. A bare repository's config and hooks stay writable, since setting up a
  server's hooks can be the task, unless it is named `.git` or has worktrees, where the user runs git.
  bubblewrap can only make a path read-only by binding something over it, which creates a missing one: a
  missing hooks directory is created empty, which runs nothing (git's default one holds only samples, which
  never run either), but an empty `commondir` would break git. Nor can it keep a submodule's checkout in
  place short of fixing every directory above it in the project. So on Linux a command can still create a
  `commondir` or `config.worktree`, or put another checkout in a submodule's place, and jig warns after the
  task and when a session ends; Seatbelt refuses them (a symlink in a checkout's place gets the warning).
  With jig started in a subdirectory of a repository, a `.git` a command makes there, or the directory made
  a git directory itself (`git init --bare .`), is the repository the user's git there finds, and so is one
  in a directory between them; making a repository can be the task, so neither sandbox refuses it, and jig
  warns of it the same way. The sandbox finds the repository by the nearest `.git`, whatever the git
  directory it leads to is called, and submodules' git directories by their `config` or `HEAD`, not by
  whether git takes them for one: git passes over a git directory whose `HEAD`, `objects` or `refs` are
  gone or broken, and those stay writable, as git changes them all the time. When the sandbox asked git, a
  command that moved `.git/HEAD` aside had the next session lock nothing there, and a command in that one
  could change the config and put `HEAD` back. jig warns of such a move as well. A job a command leaves in
  the background can still do it after jig has looked, and after a one-shot run nothing looks again. The
  search for the `.git` stops where git's does: at a bare repository, a git directory (`HEAD`, and
  `objects` and `refs` where its `commondir`, if any, leads) whose `config` says it is bare, and at
  `GIT_CEILING_DIRECTORIES`. Going on, it took a home directory's dotfiles repository for the project's,
  and let commands write in it. Stopping at a `config` alone, which a command in a subdirectory of a
  repository can write, the next session there locked nothing. A command can make a whole repository too,
  bare or not, so what the repositories around the project's have where commands can write stays read-only
  (the `.git` of a submodule checkout in the project, say, or the config of one in a temp directory), and
  the directories holding it there in place. Their git directories are never made writable, and no bind of
  git's shows jig's own directory again. The submodules' configs, which say where their checkouts are, are
  read by one git for all of them, since a dotfiles repository around every project can have dozens.
  Commands can still make a repository of their own (a submodule whose git directory is in its checkout is
  one), so jig's git doesn't rely on any of this.
- **Deny rules are a guardrail, not a boundary.** No pattern catches every disguise (`g\it push`,
  `$(echo git) push`), so deny rules err on the side of refusing and the sandbox is what actually limits
  what a command can do.
- **Snapshots in a private repository.** `git stash` would change the user's repository and miss untracked
  files; a second git directory with the project as its work tree snapshots everything that isn't ignored,
  deduplicates unchanged files, and leaves the project untouched. It never copies `node_modules/`, `dist/`,
  `build/`, `target/`, `.jig/` and the like, even where the project's own git tracks them, so `/undo`
  leaves those as they are. Nested repositories (submodules, clones) are left out: git checks one it stores
  by running `git status` in it, which runs the programs its config names (a clean filter, say) outside the
  sandbox, and a command can make one. So jig's git only lists them, and `/undo` leaves the files in them
  as they are. Paths go back to git as the bytes it listed, on its standard input: on Linux a command can
  give one a name that isn't UTF-8, and decoded, the pathspec that left it out matched nothing. The
  hidden paths are left out too, by where they really lead: a command could read a copy back out of the
  store. And the sandbox hides jig's own directory from commands, but for the skills whose scripts the
  model runs, since its snapshots (the hidden paths too, in those older versions took) and sessions hold
  copies of every project's files. It hides it by path, so where it lies in a directory commands can
  write in (a temp directory, in skill evals), the directories holding it there stay in place, as git's
  do: in a review, a command moved one aside, and read the snapshots at their new path in the next.
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
  something shaped like an API key, a token, a private key or a password assignment, or a password in a
  URL whose host isn't this machine or an example, since `postgres://postgres:postgres@localhost` is the
  kind of local convention AGENTS.md is for. A JWT is blanked out of exports only: tests hold made-up ones.
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
  everything it read, so it gets one more call, without tools, to write up what it found, as it does when
  it is stopped for repeating itself or for replying twice with nothing. So does the main loop at its step
  limit, with what it changed, verified and left undone: without it, a run that hit the limit left the user
  "Stopped after 50 steps" and a diff to read (Python-Markdown's second attempt). The reply is a report,
  not evidence, and not a finished answer to train on. The runs in `bench/` leave it out (`--no-wrap-up`):
  at evolve2's four steps every attempt would make the extra call, and costs would no longer compare with
  earlier runs.
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
  one dropped connection had ended a Terminal-Bench task. Once a reply has started, nothing in the SDK
  bounds the wait for the rest of it: a server can hold the connection open and send nothing, and
  DeepSeek, under load, sends only keep-alive comments for up to 30 minutes. So jig watches each reply's
  events (comments and pings don't count): after a minute without one it says so, and after 5 minutes it
  asks again, as for a reply that broke off. The limit is generous because a model can think for minutes
  without showing anything, and `JIG_STREAM_IDLE_MS` changes it.
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
