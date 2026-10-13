# Milestones

jig was built in milestones, each measured before the next began, and each written up here as it was
finished, including what didn't work. Milestones 1 to 8 are written up in [evaluation.md](evaluation.md);
the [README](../README.md) has a one-line summary of each.

## All of them

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
- [x] **26. A training set from jig's own successes:** `bench/dataset.ts`: every passed session of jig as it was, from the benchmark and Terminal-Bench, kept only if it finished, never reached the answers (8 hadn't, milestone 14's leak among them) and fits, five per task, split whole by task: 225 training examples from 60 tasks (1.71M tokens), 113 held out from 37; a LoRA of Qwen2.5-0.5B on this Mac (`bench/train/`) cut the loss on held-out tasks by 57%, but on the model's own tokens by 20%: the rest is the prompt and the tools learnt by heart
- [x] **27. A 7B model trained on jig's successes:** a LoRA of Qwen2.5-7B-Instruct on 294 passed sessions (`bench/train/modal_train.py`, an H100 on Modal, the loss on the model's own tokens only), served with vLLM next to the base model (`modal_serve.py`), and jig driving each on all 23 held-out tasks of the in-house suites, 3 attempts and 40 steps each: the held-out loss fell by 30% and the agent got worse, 2 of 69 against 6 of 69 (−6, −14 to 0); it stopped giving up (2 of 67 failures, against 59 of 63) but looped (25 attempts made the same call 5+ times in a row, against 2), and runaway output that jig echoes back in full as an invalid call ran 18 of its conversations past the server's 32k; $10.68 at Modal

## Milestone 9: checking before finishing

mini-swe-agent's apparent lead invited a closer look at how jig loses. 15 of its 18 failures were tasks it
finished on its own and got wrong, some after a quick look: on `mteb-retrieve` and
`model-extraction-relu-logits` it stopped after 6 to 9 turns, where mini-swe-agent's passing attempts took
19 to 36. mini-swe-agent's prompt prescribes a workflow (reproduce, fix, verify, test edge cases) and lets
it stop only through an explicit command. So `--check` tells the model in one-shot runs that nobody can
answer and to finish only once the work is checked, and the first time it stops, asks it to show what
proves each of the task's requirements.

To keep from fitting the change to the tasks it came from, it was also measured on 20 held-out tasks: a
seeded sample of the 41 eligible tasks not in the original 20 ([`eval/heldout.txt`](../eval/heldout.txt)),
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

## Milestone 10: what mini-swe-agent's lead was made of

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
  failed, as [`eval/report.py`](../eval/report.py) now does for every run, shrinks mini-swe-agent's lead on
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
    command's output open (see [the design decision](design.md#design-decisions)), so jig waited out the timeout, 2
    minutes unless the model set one, then killed the server along with the command. That cost 11
    attempts 2 to 5 minutes each. mini-swe-agent's harness has the same flaw, with a 30-second limit.
  - *A dropped connection ended the task.* Twice in the last run, DeepSeek's connection dropped in the
    middle of a reply, which the SDK doesn't retry. jig now asks again.
  - *The model's commands killed jig.* Twice in the last run, the model stopped programs by their command
    lines (`server.py`, `vm.js`), and jig's command line held the task, which named them. jig now sets its
    process title to `jig`, and the adapter passes the task on stdin (`jig -`). mini-swe-agent, which gets
    the task as an argument too, has the same exposure.

## Milestone 11: one model, two APIs

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

## Milestone 12: skills to install, write and measure

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
- **Measuring it** ([`examples/learned-skill/`](../examples/learned-skill) has the project, the skill and every run). `jig skills test acme-release --attempts 3` ran each eval three times with the skill
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

## Milestone 13: memory and context

Milestone 13 gives jig a memory across sessions, and lets it propose edits to a project's AGENTS.md:
the second piece of the plan, after skills, and under the same rule (jig proposes, you approve). The
measure is whether a later session goes better for what an earlier one left behind.

The memory benchmark ([`bench/memory/`](../bench/memory), run by `node bench/memory.ts`) has three
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

## Milestone 14: jig changes itself, and a referee decides

Milestone 14 is the last piece of the plan: jig changing its own prompts, tools and loop. A skill or a
memory can be judged by reading it; whether a line in the system prompt helps can't be, so jig proposes
the change and a referee measures it, on tasks the change wasn't made from, before anyone is asked to
merge it ([`bench/evolve.ts`](../bench/evolve.ts); the commands are under [Improving itself](../README.md#improving-itself)).

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

**The suite.** [`bench/evolve/tasks/`](../bench/evolve/tasks) has ten small Python tasks: eight are a
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

## Milestone 15: a suite that can tell a fix from luck

Milestone 14's suite could reward a cheaper jig but not a better one: jig solved 93 to 97% of it, and
the referee would have accepted a change that fixed every failure 0.7% of the time, about as often as
one that changed nothing (0.4%). Evolving needs tasks jig fails about half the time.
[`bench/evolve2/`](../bench/evolve2) is that suite, 21 tasks, and `npm run evolve` uses it by default
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
[`bench/evolve2/make/`](../bench/evolve2/make), which then checks it four ways: the starting code parses,
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

## Milestone 16: the first change the referee accepted

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

## Milestone 17: the accepted change, on Terminal-Bench

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

## Milestone 18: the answers out of reach, and a cheaper check that didn't work

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

**The exploration suite.** [`bench/explore/`](../bench/explore) has 14 tasks, written by scripts in
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

## Milestone 19: Terminal-Bench as the referee's last stage

Milestone 17 checked an accepted candidate on Terminal-Bench by hand, and milestone 18 found no cheaper
check that agreed with it, so that check is now part of the loop. `npm run evolve -- tbcheck <n>` runs a
candidate the referee accepted, and jig where it branched, on the 20 tasks in `eval/subset.txt`, in
alternating rounds (two by default: 80 trials), and records the verdict with the candidate
([`bench/evolve-terminal-bench.ts`](../bench/evolve-terminal-bench.ts)).

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

## Milestone 20: a second round, against fresh baselines

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

## Milestone 21: new causes, from today's jig

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

## Milestone 22: the loop and the tools, not the prompt

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

## Milestone 23: routing to a stronger model

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

## Milestone 24: a second model reviews the work

Milestone 23 found deepseek-flash's failures silent: it finishes sure it is done, and only the hidden
tests know otherwise. On Terminal-Bench that is most of them: of the 60 failed trials of jig as it was
(nine jobs since milestone 9), 46 ended with jig saying it was done, and 14 at the time limit. And they
repeat: filter-js-from-html failed `test_clean_html_unchanged` in all 10 of its failures, dna-assembly
`test_primers` in all 5, the kind of requirement a second reading of the task might catch. A trigger at
that moment reaches 46 failures, where milestone 23's reached 1.

`--reviewer <model>`: the first time the model stops, with steps left, a second model checks the work
against the task before the task ends. The reviewer is a subagent on its own model
([`src/review.ts`](../src/review.ts)), with the subagents' tools and rules (it reads files and runs commands
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

## Milestone 25: the key stays on the host

In milestone 24 a model, root in its task's container, printed `/proc/<pid>/environ`, and with it the API
key: jig keeps the key out of its commands' environment, but not out of the processes around them, and as
root in a container a command can read anything jig can. So the key no longer goes into the container.
[`eval/key_proxy.py`](../eval/key_proxy.py) runs on the host, on 127.0.0.1 (containers reach it as
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

## Milestone 26: a training set from jig's own successes

Milestones 23 and 24 brought in a second model, at a failure and before the end, and neither changed what
deepseek-flash gets right. What is left of milestone 21's list is training a model on what jig has done.
jig can't train one, and DeepSeek offers no fine-tuning, so this milestone builds what training would
start from, and tries it on the one trainer that fits on this machine.

`node bench/dataset.ts` gathers every attempt of jig as it was that passed tests the model never saw,
from the benchmark suites and from Terminal-Bench (runs of evolve candidates and of other system prompts
left out), exports its session (`src/export.ts`: OpenAI's chat fine-tuning format, thinking left out,
secrets blanked), and keeps it only if

- the model finished with a reply of its own: 401 didn't, nearly all of them evolve2 attempts stopped by
  their 4-step budget (372), which pass their tests but end mid-work;
- it never reached the answers: 8 sessions name the repository's own path or Terminal-Bench's
  repository, among them milestone 14's ini-config attempt, which found its task's solution on the disk
  (the path was in a tool's output, where a first check, of the tool inputs only, had missed it), and six
  Terminal-Bench trials that passed after looking the benchmark up;
- it fits in 32k tokens (27 didn't), and is among its task's 5 shortest successes (143 weren't).

A task goes whole to one side: evolve2's held-out half, Terminal-Bench's 20 held-out tasks
(`eval/heldout.txt`) and a fifth of the other suites' tasks, by name, are held out.

| | examples | tasks | tokens | the model's own | by suite |
|-|----------|-------|--------|-----------------|----------|
| training | 225 | 60 | 1.71M | 0.71M | Terminal-Bench 83, explore 46, the main suite 45, evolve2 32, evolve 19 |
| held out | 113 | 37 | 0.89M | 0.36M | Terminal-Bench 37, evolve2 36, the main suite 15, explore 13, evolve 12 |

An example is 6k tokens at the median and 16k at the 90th percentile. The files go to `bench/dataset/`
(not committed: the sessions hold the tasks' files and their output), with a manifest of every
example's task, model, run and size.

**A smoke test of the training.** This Mac (an M2 with 8 GB, Docker holding 3 of them) fits a LoRA of
Qwen2.5-0.5B-Instruct (4-bit, with MLX) on sequences of 4,096 tokens.
[`bench/train/run.sh`](../bench/train/run.sh) converts the set (`bench/train/to_mlx.py`: tool calls'
arguments become objects, as chat templates expect), trains on the 166 training examples under 8k tokens
(each one's first 4,096) for two epochs, and measures the loss on 85 held-out examples, the model's own
tokens apart from the rest (`bench/train/heldout_loss.py`, which checks that the chat template builds
each conversation from its beginnings, so the split is exact):

| loss on held-out tasks, nats a token | all tokens | the model's own (96k) | the rest (239k) |
|---------------------------------------|------------|-----------------------|-----------------|
| Qwen2.5-0.5B-Instruct | 1.667 | 1.219 | 1.847 |
| after the LoRA | 0.714 | 0.975 | 0.609 |

- **Most of the drop is the setting, not the work.** The trainer's own test loss fell by 57%, but most of
  that is the rest: the system prompt and tool definitions, which are the same in every example, the
  tasks' shape and the tools' output, all of which a model can learn by heart. On what the model writes,
  its replies and tool calls on tasks it never trained on, the loss fell by 20%. The validation loss was
  lowest after one epoch (0.511) and a little higher after two (0.531).
- **What it shows, and what it doesn't.** The set trains, end to end, through a real trainer, and what
  the model writes on unseen tasks becomes more like what flash wrote when it succeeded. Whether that
  makes a better agent needs a model large enough to be one, a GPU or a fine-tuning service to train it
  on (about 1.7M tokens an epoch), and an agent's evaluation rather than a loss: evolve2's held-out half
  through `--api openai --base-url` (milestone 11), the base model against the fine-tuned one.

**Cost.** Nothing at DeepSeek: about an hour of this Mac.

## Milestone 27: a 7B model trained on jig's successes, driving jig

Milestone 26 built the training set and showed, on a 0.5B model, that it trains. This one trains a model
large enough to be an agent, on a rented GPU, and measures it as one: jig driving the model as it was
against jig driving it after the training, on every held-out task of the in-house suites.

**The model.** Qwen2.5-7B-Instruct. Qwen2.5-Coder-7B-Instruct came first, but although its chat template
describes the tools and asks for `<tool_call>` blocks, it wrote its calls as XML in a code block
(`<function name="bash">…`), so jig got no calls from it at all, and a comparison would have measured a
format being learnt. The general model's calls parse, and it ran jig's loop from the first try.

**The data.** `node bench/dataset.ts --per-task 10` (milestone 26 kept 5 a task): 294 training examples
and 115 held out. By Qwen's tokenizer a training example is 6.9k tokens at the median, 21.4k at the 90th
percentile and 46.4k at the longest (the 6 longer than 32,768 are cut to their first 32,768), 2.81M in
all, 1.13M of them the model's own.

**The training** ([`bench/train/modal_train.py`](../bench/train/modal_train.py), one H100 on Modal): a
LoRA of rank 16 (alpha 32) on every projection, learning rate 1e-4 with a warmup and a cosine decay, 8
examples a step, two epochs. The loss is on the model's own tokens only, its replies and tool calls
(milestone 26 found a loss over every token mostly measures the system prompt learnt by heart), and only
those positions get logits at all, which is what lets a 32k-token example fit. The adapter to evaluate,
the last epoch's, was chosen before training. It took 40 minutes:

| loss on the held-out examples' own tokens (409k), nats a token | |
|-----------------------------------------------------------------|-|
| Qwen2.5-7B-Instruct | 0.853 |
| after one epoch | 0.608 |
| after two | 0.593 |

Two things a smoke test caught first: with a warmup, the first step's learning rate is 0, so a one-step
test changes nothing (24 examples did: 0.996 to 0.973); and transformers' `apply_chat_template` now
returns a dictionary unless told not to.

**Serving** ([`bench/train/modal_serve.py`](../bench/train/modal_serve.py)): vLLM 0.21 on an L40S, with
the base model as `qwen-base` and the LoRA as `jig` on the same server, so both sides run on the same GPU
and software, 32,768 tokens a conversation, and a token that every request must carry. jig drives it as
any OpenAI-compatible API: `--api openai --base-url <url>/v1 --compact-at 24000`.

**The evaluation** ([`bench/train/eval.sh`](../bench/train/eval.sh)): every held-out task of the four
in-house suites (`node bench/dataset.ts --held-out <suite>`), 23 tasks that no training example came
from: the main suite's config-migration, git-merge, injection-output, inventory and mcp-ticket; 4 of
evolve's; evolve2's 11; 3 of explore's. Three attempts each, 40 steps (evolve2's own 4 would leave a 7B
model nothing to show). The base model ran while the LoRA trained, and the LoRA after; with a server of
our own, no one else's load changes the replies between the two.
[`bench/train/compare.ts`](../bench/train/compare.ts) pairs them by task:

| | passed | steps | failed tool calls | stopped, unsolved, before the limit | made the same call 5+ times in a row | outgrew the server's 32k | the main suite | evolve | evolve2 | explore |
|-|--------|-------|-------------------|--------------------------------------|---------------------------------------|---------------------------|----------------|--------|---------|---------|
| Qwen2.5-7B-Instruct | 6 of 69 (9%) | 8.5 | 2.2 | 59 of 63 failures | 2 of 69 | 2 of 69 | 6 of 15 | 0 of 12 | 0 of 33 | 0 of 9 |
| after the LoRA | 2 of 69 (3%) | 24.5 | 11.4 | 2 of 67 | 25 of 69 | 18 of 69 | 2 of 15 | 0 of 12 | 0 of 33 | 0 of 9 |

Paired by task, the trained model is 6 points behind (−14 to 0) and ahead in none of the resamples. It
lost on injection-output (3 of 3 to 2 of 3), inventory (2 to 0) and mcp-ticket (1 to 0), and solved
nothing anywhere the base model hadn't. Neither followed the injected instruction (0 of 3 each).

- **It learnt to keep going, not to get there.** The base model ended 59 of its 63 failures by saying it
  was done, 8.5 steps in. The trained one almost never did (2 of 67): it ran out of steps 35 times, out
  of time 12, and out of room 18. What it took from flash's successes is their shape (keep working, run
  the tests, write test cases of its own) without what made them succeed: in 25 attempts it made the same
  call five or more times in a row, against 2, and one of its replies on config-migration held 211 calls,
  208 of them the same edit.
- **Runaway output, and jig's echo of it.** In 17 of the 19 attempts that ended because the conversation
  outgrew the server (18 of them the trained model's), the model had written until its output ran out
  (one command writing test files until the 218th was cut off; for the base model, 9,700 blank lines), so
  the call wasn't valid JSON, and jig sends an invalid call back to the model in full, so it can see what
  it wrote: 40k to 155k characters in one tool result. Compaction can't save that conversation, since it
  sends the whole of it to the same server. The fix belongs in jig (send back the start of an invalid
  call and the parse error, and compact before a request that won't fit); it isn't made here, so that
  milestone 28 compares jig as it was.
- **The loss fell by 30% and the agent got worse.** Milestone 26's caution, measured: the loss says how
  much the model's tokens look like flash's when flash succeeded, in the context of a success. As an
  agent, the model writes in contexts of its own, and once it is off course, nothing it trained on shows
  what to do there: every example is a success, and none shows an edit failing and what came next. The
  next things to try train on the agent's own attempts, scored by the hidden tests (rejection sampling,
  or reinforcement learning), which put the model in its own states; or start from a stronger model.
  Either needs more GPU time than this milestone's.

**Cost.** Nothing at DeepSeek. Modal billed $10.68: $4.35 for training (the H100, with the Coder model's
start and the smoke tests) and $6.33 for three hours of serving.
