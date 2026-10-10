# A skill learned from one session

Milestone 12's experiment, as it ran: a project whose release procedure is written down nowhere, one
session in which the user explains it, the skill `jig skills learn` made of that session, and that
skill's evals, run with it and without it.

- [`project/`](project): the "acme" project as it was before the first session (release 1.4.2).
- [`acme-release/`](acme-release): the skill jig proposed after the session, exactly as it proposed it:
  the instructions and three evals, each with a starting project of its own and a check.
- [`results.json`](results.json): every run of `jig skills test acme-release --attempts 3` (with and
  without the skill, the check, the grader's verdict on each expectation and its evidence).

To repeat it (it costs about 1 CNY on deepseek-flash):

```bash
cp -R project /tmp/acme && cd /tmp/acme
git init -q -b main && git add -A && git commit -qm "acme 1.4.2" && git tag -a v1.4.2 -m "acme 1.4.2"

# The first session: the user explains the procedure while asking for a release.
jig --yes "Cut release 1.4.3. Here's how releases work in this project, since it isn't written down \
anywhere: (1) the version lives in three places that must match: VERSION, the version field of \
package.json, and __version__ in src/acme/__init__.py. (2) In CHANGELOG.md, the entries under \
'## [Unreleased]' move into a new section '## [1.4.3] - <today's date, YYYY-MM-DD>' right below it, and \
an empty '## [Unreleased]' stays on top. (3) Run python3 scripts/check_versions.py; it must print OK. \
(4) Commit everything with the message 'Release v1.4.3' and create an annotated tag v1.4.3 with the \
message 'acme 1.4.3'."

jig skills learn                      # proposes a skill; in a terminal, choose [p]roject to keep it
jig skills test acme-release --attempts 3
```

Without a terminal to approve it in, `jig skills learn` saves the skill to `.jig/proposals/skills/`,
and `jig skills add .jig/proposals/skills/acme-release --project` installs it.
