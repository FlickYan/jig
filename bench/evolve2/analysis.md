<!-- The analysis of bench/results/evolve2/2026-10-12T18-00-05_baseline-m19a.json's training attempts by deepseek-flash, for $0.0070. What it was shown: bench/evolve2/analysis-prompt.md -->

One line per attempt:

1. bank/statement: all 4 steps spent reading modules; never edited anything.
2. bank/statement: 4 steps, all reads; stopped before writing.
3. bank/statement: 4 steps reading every module plus the visible tests; no code written.
4. library/issue: 4 steps, 12 reads; no edit made.
5. library/issue: read everything, ran pytest (not installed), no edit.
6. words/spec: wrote a full rewrite on the last step; `from_words` unhandled/erroring, no step left to fix.
7. words/spec: 4 steps of reads; no file written.
8. words/spec: rewrite rejects inputs the spec accepts ("invalid text"); never verified.
9. payroll/spec: rewrite with wrong bucketing of hours; assertion mismatches, no repair step.
10. payroll/spec: rewrite raises KeyError on days not present; no run to catch it.
11. shop/cents: 4 steps, 12 reads; no edit.
12. shop/cents: 4 steps of reading; no edit.
13. shop/cents: wrote 4 modules but never changed the consumer, so `Order` lacks the new attribute.
14. table/spec: wrote, then spent the last step patching truncation; totals still broken/unverified.
15. toml/spec: 4 steps of reads; no file written.
16. units/spec: 4 steps, ending in Unicode byte inspection; no file written.
17. units/spec: wrote and ran tests, but treated `1`/dimensionless as invalid — mismatch not covered by visible tests.
18. units/spec: rewrite mishandles equivalent spellings; no verify step.
19–24. passing: wrote early, and within budget; the ones that pass waste fewer steps on reading and one has a cheap post-write run.

## Causes

1. It front-loads reconnaissance and treats "understand everything" as prerequisite to writing, so with a small step cap it exhausts all steps on reads and never produces an edit. It should spend at most ~3 calls (spec/issue, visible tests, the one target module) and then write, iterating afterwards.
2. It explores by dumping the repo — `ls`/`find`/`glob`, then opening every sibling module — rather than reading only the files the spec and tests point at. It should let the spec and test file select the modules instead of enumerating the package.
3. It writes one large whole-file rewrite and then has no steps left to verify or repair; when the test runner is missing or misinvoked it gives up instead of falling back to a direct script. It should run the visible tests immediately after writing and treat the remaining steps as repair budget.
4. On multi-file changes it edits the modules it read but skips the consumer/entry point that the hidden tests exercise, leaving missing attributes and `NotImplementedError`. It should map each item in the issue to every file that must change before editing.
