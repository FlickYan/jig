# A real issue: Python-Markdown #1651

jig on a bug in a project it has never seen, filed after the model's training data ends:
[Python-Markdown #1651](https://github.com/Python-Markdown/markdown/issues/1651), "Text after an unclosed
end tag such as `</dev/null` is dropped on Python 3.13.6+", opened and fixed upstream on 2026-10-05
([7c265bc](https://github.com/Python-Markdown/markdown/commit/7c265bc79d8946ac42bb61a39f9052c8e261340f)).

```python
>>> markdown.markdown("Discard errors with `cmd 2</dev/null` and keep going.\n\nThis second paragraph must survive.")
'<p>Discard errors with `cmd 2</p>'
```

Why this issue:

- **The fix can't be remembered.** The issue was filed on 2026-10-05; jig's default model, deepseek-flash,
  was already in use here on 2026-10-01 (milestone 1), so neither the issue nor its fix can be in its
  training data.
- **The cause isn't where the symptom is.** Nothing in Python-Markdown changed: on Python 3.13.5 the same
  code renders the whole document. A change to CPython's `html.parser` (gh-135462, the reporter found)
  made it drop an unfinished end tag, and everything after it, at the end of the input, and
  Python-Markdown's override of `parse_endtag` in `markdown/htmlparser.py` had counted on the old
  behaviour. To find that, the agent has to read Python-Markdown's parser and the standard library's.
- **The bug is silent.** No error and no failing test: the text is gone, and the suite of 1,099 tests
  passes.
- **The upstream fix comes with tests.** The maintainers added three regression tests, so there is a
  grade nobody wrote for jig.

## The setup

| file | what it is |
|------|------------|
| [`prompt.txt`](prompt.txt) | what jig is asked, word for word |
| [`setup.sh`](setup.sh) | the project: Python-Markdown at [7a29324](https://github.com/Python-Markdown/markdown/commit/7a29324e03725fe279790c2f59d13ebda0eecbe1), the fix's parent, with a development install in `.venv` |
| [`check.sh`](check.sh) | the grade: upstream's regression tests, then the whole test suite |
| [`run.sh`](run.sh) | one attempt: the project, jig on the prompt, the grade, and everything kept in `results/` |
| [`results/`](results) | the three attempts below, each with everything `run.sh` keeps |
| [`compare.py`](compare.py) | jig's fixes next to upstream's on a generated corpus, beyond the hidden tests |
| [`upstream/`](upstream) | the upstream fix ([`fix.patch`](upstream/fix.patch)), its three tests in a file of their own ([`test_issue_1651.py`](upstream/test_issue_1651.py)), and Python-Markdown's license |

- **The prompt is the user's side of the issue.** It gives the symptom, a reproduction (not the one in the
  hidden tests), the Python versions the issue names, and how to run the tests. The issue's diagnosis, its
  pointer to CPython's change, is left out, so finding the cause is jig's job.
- **The project holds no answer.** `setup.sh` fetches only the fix's parent and its ancestors, and keeps no
  remote, so the fix is in neither the files nor the history.
- **The answers are hidden.** `run.sh` gives jig a home of its own (no memories, skills or settings from
  the machine), whose settings hide this folder (upstream's fix and tests) and jig's repository history
  from jig's commands; jig's file tools work only in the project. Commands run in jig's sandbox, which
  also keeps them off the network, so the fix can't be fetched either. This is how the benchmark keeps its
  answers out of reach ([milestone 18](../../docs/milestones.md)). The sandbox can still read the rest of
  the machine, though, and in the run below two copies of a fix were left where it could: the oracle
  check's output, with upstream's fix, was written to `/tmp` before the attempts, and `run.sh` kept each
  attempt's project, attempt 1's for attempts 2 and 3. No attempt went near them (no command or output in
  the three sessions names another folder in `/tmp`), and `run.sh` now deletes each project after grading
  it (`KEEP=1` keeps it); an oracle check's output belongs in `results/`, where it goes by default, which
  is hidden.
- **Solved means both.** Upstream's three tests must pass, and so must the whole suite, so a fix that
  breaks rendering the suite covers fails.
- **The check is checked.** With upstream's fix applied (`AGENT=oracle run.sh`) the case comes out
  solved, and with nothing changed (`AGENT=noop run.sh`) it doesn't: the three tests fail and the suite
  passes. Both on Python 3.13.16. And the cause is where the issue says: the same code, on CPython's own
  `html/parser.py` from v3.13.5, renders the whole example, and on the one from v3.13.6 drops the text.

## Results

Three attempts on 2026-10-14, one after another, with jig's default model (deepseek-flash) and no other
options, on Python 3.13.16: **3 of 3 solved**. Each kept its record in [`results/`](results).

| attempt | grade | steps | ended | time | tokens in (from cache) | out | cost |
|---------|-------|-------|-------|------|------------------------|-----|------|
| [1](results/2026-10-14T18-55-21-jig) | solved | 37 | with a summary | 144 s | 981k (97%) | 18.8k | $0.037 |
| [2](results/2026-10-14T18-57-52-jig) | solved | 50 | at the step limit, with no summary | 187 s | 1,743k (98%) | 26.9k | $0.054 |
| [3](results/2026-10-14T19-01-07-jig) | solved | 40 | with a summary | 153 s | 1,035k (98%) | 20.7k | $0.038 |

Costs are from jig's price table, at DeepSeek's list price (it bills half that off-peak). "Solved" is
`check.sh`: upstream's three tests pass, and so does the whole suite, now 1,101 to 1,103 tests with the
ones jig added. A step is a model call; the step numbers below are those of each attempt's
`session.jsonl`.

### What jig did

All three found the same cause and made the same fix, by different roads:

- **Attempt 3, the straightest.** It reproduced the bug at step 1, read `markdown/htmlparser.py` at step 3
  and the standard library's `goahead` and `parse_endtag` at steps 4–5, and at step 15 stated the cause
  and fixed it. Then it added two tests (step 20), a changelog entry (step 22), checked the suite and some
  raw-HTML and `md_in_html` cases, and ended with a summary that also explains the version boundary:

  > **Cause:** In Python 3.13.6, `html.parser.HTMLParser.goahead` changed to match the HTML5 spec. When an
  > end tag like `</dev/null` has no closing `>`, `parse_endtag` returns `-1` and `goahead`, at end of
  > input, discards *all* remaining buffered data instead of emitting it as text (older Pythons fell back
  > to `handle_data`). Markdown's `_HTMLParser` let that `-1` propagate, so everything from `</dev/null` to
  > the end of the document vanished silently.

  That is right (CPython 3.13.5's `goahead` does hand the rest to `handle_data`), though it could only
  reason it out: the machine had no Python without the change to try.
- **Attempt 1.** Reproduced at step 2, read Python-Markdown's parser and the standard library's at
  steps 3–6, and confirmed the mechanism at step 8 by instrumenting `parse_endtag`, which returned −1 both
  in `feed` and in `close`. It fixed it at step 21, added two tests and a changelog entry, ran the suite on
  3.13 and 3.12, and ended with a correct summary of the cause and the fix. The summary doesn't say why
  the bug depends on the Python version.
- **Attempt 2, the long way.** It spent most of steps 3–12 on the inline patterns, the tree processor
  and the latest commit, until wrapping the inline stage (steps 13–14) showed that the text was already
  gone before it; that took it to `htmlparser.py` at step 15 and the standard library at steps 16–18. Its
  first fix (step 32) only handled an end tag with no `>` anywhere after it, although outputs it had seen
  at steps 27 and 31 already lost text with a `>` further on. Its checks at steps 35–36 showed the gap, and
  at step 40 it reworked the fix into the same form as the others. It then spent its last ten steps on a
  test, a changelog entry and checks, and hit the 50-step limit before writing a summary: the work was
  done, but the user would have been told nothing about it.

### Next to upstream's fix

Upstream's fix to `_HTMLParser.parse_endtag`, and attempt 1's (its comment left out):

```diff
 # upstream, 7c265bc
-        if len(start) < 3 or not (65 <= c <= 90 or 97 <= c <= 122):
+        is_data = len(start) < 3 or not (65 <= c <= 90 or 97 <= c <= 122)
+        pos = super().parse_endtag(i) if not is_data else -1
+        if pos == -1:
             self.handle_data(self.rawdata[i:i + 2])
             return i + 2
-        return super().parse_endtag(i)
+        return pos
```

```diff
 # jig, attempt 1
         if len(start) < 3 or not (65 <= c <= 90 or 97 <= c <= 122):
             self.handle_data(self.rawdata[i:i + 2])
             return i + 2
-        return super().parse_endtag(i)
+        endpos = super().parse_endtag(i)
+        if endpos == -1:
+            self.handle_data(self.rawdata[i:i + 2])
+            return i + 2
+        return endpos
```

All three do what upstream does: when the base class can't parse the end tag, emit the `</` as text and go
on. Upstream folds both cases into one branch; jig kept the existing early return and added a second one
like it. Attempts 2 and 3 test `< 0` where upstream tests `== -1`, which is the same here, since the base
`parse_endtag` returns no other negative value. Beyond the three hidden tests,
[`compare.py`](compare.py) checks this:

- **Same output on 148,188 renders.** It generates 49,396 inputs aimed at this code (every short context
  around `</` and `<`, in and out of code spans and raw HTML blocks, at the end of the document and before
  more paragraphs, plus random strings) and renders each with no extensions, with `md_in_html` and with
  `extra`. Each of jig's three fixes gives exactly upstream's output for all of them; the code before the
  fix differs from upstream on 11,644 inputs, so the corpus does reach the bug.
- **Its own tests test the bug.** Each attempt's added tests fail on the code before the fix and pass
  with upstream's fix. Like upstream, each attempt also added a changelog entry, without an issue number
  since it had none (attempts 1 and 3 said so to the user). Upstream also added "unterminated" to the
  project's spelling dictionary (`.spell-dict`); attempt 3 used that word and "unparseable", which the
  dictionary lacks too, and no attempt ran the project's spell check.

### What went wrong

- **The version question.** The user said 3.13.5 is fine and 3.13.6 isn't. Every Python on the machine
  already had the new `html.parser`: 3.13.16, 3.11.17, and Ubuntu's 3.12.3, which carries the change as a
  backported security patch. Attempts 1 and 2 ran the bug on them and saw it everywhere, with nothing
  to tell the versions apart. Attempt 2 told the user "The bug reproduces across Python versions here.";
  attempt 1 left the versions out of its summary. Only attempt 3 explained them. Attempt 3 took the prompt's
  "3.13.6 and later" at its word, without running the machine's 3.11 and 3.12, which drop the text too.
  The fix is right on every version, but two of three users wouldn't have learnt why it broke when it
  did.
- **Made-up issue numbers.** Not knowing the issue's number, attempt 2 wrote "(see #1654)" into a code
  comment at step 32 and attempt 3 "(see #1648)" into a test's docstring at step 20. Each removed it at the
  next step, and no final diff has one.
- **No summary from attempt 2**, above. The default limit is 50 steps; a user who saw "Stopped after 50
  steps" would have had to read the diff.

### Did it look the answer up?

No attempt got at the answer, but each looked for it:

- **Nothing reached the answer.** No command touched the hidden folders, and none reached the network: the
  only command that could have was a `pip download` with nothing to download (attempt 1, step 11), which
  stops before any fetch. Two `find /` searches for other copies of `html/parser.py` (attempts 1 and 2)
  found only the standard library's.
- **Each looked.** Attempt 2 ran `git branch -a`, `git tag` and `git log --all` at step 38 to see whether
  the fix was in the repository (it wasn't); attempt 3 looked through the log for hints at step 10;
  attempt 1 looked for other Pythons, and a pip cache, for an older `html/parser.py`. The benchmark counts
  an attempt that reaches the answer as failed; none did.
- **The CPython change, from memory.** The prompt leaves out the reporter's pointer to CPython's change,
  but all three guessed it in their thinking ("gh-135462?", among wrong numbers) before confirming the
  mechanism in the standard library's source. That change is from 2025, before the model's training data
  ends; the Python-Markdown fix isn't, and no attempt mentioned #1651, the upstream commit or its wording.

### What this shows, and what it doesn't

One issue and three attempts show what jig does on a real bug it can't have seen, not how often it
succeeds: for that there are the benchmarks ([docs/evaluation.md](../../docs/evaluation.md)). The prompt is
ours, the issue's symptom without its diagnosis, not the reporter's text. And the first try died before
its first model call with `API error: Connection error.`: the container reached the API only through a
proxy, which Node's `fetch` doesn't use unless `NODE_USE_ENV_PROXY=1` is set. It was deleted and the
attempt run again with that set; the three above are the first three that reached the model.

## To repeat it

You need Node 22.18 or newer, git, a Python on which the bug shows (3.13.6 or later, 3.12.14 or later,
3.14, or a distribution's build that has the change backported, like Ubuntu 24.04's 3.12.3; `setup.sh`
checks), network access for `setup.sh` (GitHub and PyPI), and on Linux bubblewrap for the sandbox
(`sudo apt install bubblewrap`). Where the internet is reachable only through a proxy, set
`NODE_USE_ENV_PROXY=1` so that Node's `fetch`, and so jig, uses it. From the root of a clone of jig, after
`npm install`:

```bash
export DEEPSEEK_API_KEY=sk-...                      # or ANTHROPIC_API_KEY, and add --model claude-opus-5-5
examples/python-markdown-1651/run.sh                # one attempt; extra arguments go to jig
AGENT=oracle examples/python-markdown-1651/run.sh   # upstream's fix: solved
AGENT=noop examples/python-markdown-1651/run.sh     # nothing changed: not solved
python3 examples/python-markdown-1651/compare.py    # the attempts in results/ next to upstream's fix
```

Each attempt leaves a folder in `results/` with what jig printed (`transcript.txt`), its session, every
message and tool call (`session.jsonl`), the model calls, tokens and tool calls (`stats.json`), what it
changed (`diff.patch`), and the grade (`check.txt`). If another checkout of Python-Markdown on the machine
holds the fix, hide it too, or the attempt could read it.

Python-Markdown is BSD-licensed; the files in `upstream/` come from it, under
[its license](upstream/LICENSE.md).
