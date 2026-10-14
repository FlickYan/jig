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
| [`upstream/`](upstream) | the upstream fix ([`fix.patch`](upstream/fix.patch)), its three tests in a file of their own ([`test_issue_1651.py`](upstream/test_issue_1651.py)), and Python-Markdown's license |

- **The prompt is the user's side of the issue.** It gives the symptom, a reproduction (not the one in the
  hidden tests), the Python versions it shows on, and how to run the tests. The reporter's diagnosis,
  the pointer to CPython's change, is left out, so finding the cause is jig's job.
- **The project holds no answer.** `setup.sh` fetches only the fix's parent and its ancestors, and keeps no
  remote, so the fix is in neither the files nor the history.
- **The answers are out of reach.** `run.sh` gives jig a home of its own (no memories, skills or settings
  from the machine), whose settings hide this folder (upstream's fix and tests) and jig's repository
  history from jig's commands. Commands run in jig's sandbox, which also keeps them off the network, so
  the fix can't be fetched either. This is how the benchmark keeps its answers out of reach
  ([milestone 18](../../docs/milestones.md)).
- **Solved means both.** Upstream's three tests must pass, and so must the whole suite, so a fix that
  breaks other rendering fails.
- **The check is checked.** With upstream's fix applied (`AGENT=oracle run.sh`) the case comes out
  solved, and with nothing changed (`AGENT=noop run.sh`) it doesn't: the three tests fail and the suite
  passes. Both on Python 3.13.16.

## Results

Not run yet.

## To repeat it

You need Node 22.18 or newer, git, a Python on which the bug shows (3.13.6 or later, 3.12.14 or later, or
3.14; `setup.sh` checks), network access for `setup.sh` (GitHub and PyPI), and on Linux bubblewrap for the
sandbox (`sudo apt install bubblewrap`). From the root of a clone of jig, after `npm install`:

```bash
export DEEPSEEK_API_KEY=sk-...                      # or ANTHROPIC_API_KEY, and add --model claude-opus-5-5
examples/python-markdown-1651/run.sh                # one attempt; extra arguments go to jig
AGENT=oracle examples/python-markdown-1651/run.sh   # upstream's fix: solved
AGENT=noop examples/python-markdown-1651/run.sh     # nothing changed: not solved
```

Each attempt leaves a folder in `results/` with what jig printed (`transcript.txt`), its session, every
message and tool call (`session.jsonl`), the model calls, tokens and tool calls (`stats.json`), what it
changed (`diff.patch`), and the grade (`check.txt`). If another checkout of Python-Markdown on the machine
holds the fix, hide it too, or the attempt could read it.

Python-Markdown is BSD-licensed; the files in `upstream/` come from it, under
[its license](upstream/LICENSE.md).
