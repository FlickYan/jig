<!-- The analysis of bench/results/evolve/2026-10-11T01-17-27_baseline.json's training attempts by deepseek-flash, for $0.0045. What it was shown: bench/evolve/analysis-prompt.md -->

**Per attempt**

1. *semver satisfies — FAILED (9 steps):* accepted the invalid range `^`; its probes covered the spec's examples and precedence chain but no invalid inputs, and its last two steps went to ad-hoc scripts and an npm-`semver` cross-check instead of the spec's validity rule.
2. *durations — pass (14):* spent steps hunting for hidden tests in git history (`log --all`, branches, tags, remotes), then converged through three `edit_file` rounds each re-verified by hand.
3. *urlpath — pass (8):* near-clean; one write, two heredoc probe blocks, plus an interpretation note in the summary.
4. *roman — pass (12):* oscillating one-line-edit → full test → ad-hoc script, four times, to settle rejection cases.
5. *semver — pass (12):* wrote the 272-line file, re-read it, then wrote the identical file again; one bash call had a mistyped working directory and needed an immediate retry.
6. *templates — pass (6):* efficient; the only "failure" was its own wrong probe expectation, which it correctly overruled against the spec.

## Causes

1. **Verification is example-driven, not rule-complete.** jig probes the behaviours the spec illustrates and the ones it inferred, rarely the spec's explicit rejection clauses; the failed run never tested an operator with no version, so an invalid range passed. It should enumerate every stated rule — especially "X raises / X is invalid" — and exercise each before finishing.
2. **Terse spec text is resolved by outside reference or guess, then flagged.** When the grammar left room, jig consulted npm's semantics or picked a reading and reported the judgement call in its closing message rather than deriving the answer from the spec's own rules and examples. It should treat SPEC.md as the sole authority and let the spec's stated cases decide ambiguities.
3. **Single-change → full-verify churn.** Consecutive attempts burn steps on one-line edits, whole-file rewrites (once byte-identical), and full test-plus-probe runs after each. It should batch related changes and verify once, and never re-write a file it just read unchanged.
4. **Searching for the grader instead of the spec.** Steps go to git history, tags, remotes, and test-file globs in hopes of finding hidden tests. It should read the visible tests once for interface, and spend the rest on SPEC.md.
