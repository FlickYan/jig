# How the evolve2 tasks were made

Each `t_<task>.py` writes one task of `bench/evolve2/tasks/` (its spec or issue, its starting code, its
visible and hidden tests, and its reference solution) and then checks it four ways: the starting code
parses, the hidden tests fail on it, they pass with the reference solution, and the project's own tests
agree with that solution. Run them from this directory: `python3 t_toml.py`.

Where a real tool can say what the answer is, the hidden tests' expectations come from it, and the
reference solution was checked against it on random inputs too:

| task | ground truth | cross-check |
|------|--------------|-------------|
| gitignore-match | real git (`git check-ignore`, `core.ignorecase` off): `gitcases.py`, `probe_nested.py`, `git-truth.txt` | `fuzz_ignore.py`, `fuzz_nested.py`: 885 random layouts |
| toml-subset | Python's `tomllib`: `tomldocs.py`, `tomldocs2.py` | 98 documents, valid and invalid |
| rrule-dates | python-dateutil's `rrule`: `rrule_expect.py` writes `rrule-expected.json` (needs `pip install python-dateutil`) | `fuzz_rrule.py`: 2,939 random rules |
| expression-eval | Python's own `eval` | 17,498 random expressions (that script wasn't kept; see milestone 15 in the README) |
| reminder-times | Python's `zoneinfo` and the system's time zone database | |
| upload-hang | the original name pattern, for which names are accepted | `fuzz_names.py`: 100,000 random names |

The other tasks' expectations come from their reference solutions (`*_solution.py`, or inline in the
`t_*.py`), worked out by hand for the cases that matter; each `t_*.py` says which traps its cases are
for. `semver-range` is the first evolve suite's task, copied as it is.
