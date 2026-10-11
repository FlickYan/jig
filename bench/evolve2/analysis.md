<!-- The analysis of bench/results/evolve2/2026-10-11T14-51-52_baseline.json's training attempts by deepseek-flash, for $0.0086. What it was shown: bench/evolve2/analysis-prompt.md -->

Per attempt:

- statement #1: every model call spent on tree/module reading; no code written, so the subcommand was never registered.
- statement #2: same reconnaissance, then one edit adding only `parse_month`; CLI wiring never written.
- statement #3: reconnaissance only; nothing changed.
- is_ignored #1: spec, tree listing, git log, test read; no implementation.
- library #1: read every module and test, checked git, then ran a test runner that isn't installed; nothing edited.
- library #2: re-read all modules and tests after listing the tree; nothing edited.
- words #1: four reconnaissance steps then one 236-line write; ordinal lookup indexed off the end with no step left to catch it.
- payroll #1: reconnaissance then one write; break/overtime arithmetic wrong and never executed.
- shop #1: reconnaissance and grep, then rewrote four modules but never `order.py`, so the added field was absent.
- toml #1: reconnaissance, then probed the stdlib TOML module's path; no code written.
- toml #2: reconnaissance including an interpreter-version check; no code written.
- units #1: reconnaissance including an interpreter-version check; no code written.
- is_ignored #2 (pass): spec, file, tree, tests, one whole-file write.
- jsonpatch (pass): whole-file write, then ran the suite and a scripted probe.
- library #3 (pass): read all modules, then completed edits across every affected file.
- words #2 (pass): one whole-file write.
- payroll #2 (pass): one whole-file write.
- shop #2 (pass): rewrote all five modules including `order.py`.
- table (pass): whole-file write, then ran tests and a Unicode probe.
- toml #3 (pass): one 624-line write.
- units #2 (pass): one whole-file write.

## Causes

1. Reconnaissance crowds out the work. jig begins by enumerating everything — directory trees, every module, every test file, git history, interpreter and library availability — and frequently exhausts the step budget before reaching an edit, or reaches it only for one fragment of the change. It should read the spec and only the files the change actually touches, land a first complete implementation early, and use the remaining steps to verify.

2. No run-and-repair step. When it does implement, it emits one large whole-file rewrite and stops, so defects in what it wrote (bad arithmetic, off-by-one indexing, an attribute that is never set) are never observed or corrected before the hidden tests. It should reserve a step to execute the tests or a probe and iterate on what fails.

3. A multi-file change is propagated incompletely. Edits land in the files it happened to read while related call sites, constructors, or command registrations are left untouched, so the result is internally inconsistent (missing attribute, unregistered subcommand). It should trace each requirement to every site it affects and finish them all before stopping.

4. Steps are burned on non-informative probes and duplicated navigation — both `glob` and `find`, repeated `git log`, interpreter-version checks, invoking an uninstalled runner — and on private deliberation about edge cases in prose instead of settling them by running code.
