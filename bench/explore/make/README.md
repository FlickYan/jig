# How the exploration tasks were made

Each `t_<name>.py` writes one task of `bench/explore/tasks/` and checks it four ways, as `bench/run.ts`
will run it (the project copied, committed, and `setup.sh` run where there is one): the starting code
parses, the hidden tests fail on it, they pass with the reference solution, and the project's own tests
agree with that solution. Run them from this directory: `python3 t_stock.py`.

What the tasks have in common: what the agent needs isn't in the instruction, but somewhere in the
project, so working it out is the task. A first draft written from the instruction alone fails.

| task | what has to be found, and where |
|------|---------------------------------|
| stock-export | how commands are registered (`stock/commands/__init__.py`), written (`stock/files.write_csv`: the export directory from `stock.ini`, the file name, money in cents) and printed (`stock/output.emit`, `--json`); `docs/commands.md` |
| vendored-retry | the vendored retry helper (`vendor/retrying_lite`), and how `reports/customers.py` uses it: the attempts and backoff in `reports/settings.py`, `reports.clock.sleep`, the project's own error |
| tax-rounding | that the report only adds up invoices: the cents go missing in `billing/money.tax`, reached only through region plugins loaded by name from `config/regions.txt`; the rounding rule is in `docs/money.md` |
| meter-formats | the three export formats, which only the files in `data/` show (semicolons and decimal commas, a byte-order mark, comment blocks, a TOTAL line) |
| credit-limit | where the API and the CLI meet (`shop/orders.place_order`), the limit with its overrides and trusted customers (`shop/customers.credit_limit`), what is owed (`shop/ledger.outstanding`), the error both front ends map (`shop/errors.Refused`) |
| nightly-import | what broke, which only the latest of three logs in `logs/` says: the row with a quoted, comma-holding name |
| bulk-discount | the discount before the 2.0 rewrite, which only the git history holds (`setup.sh` writes it: tiers, a cap, the rounding fix) |
| api-docs | that `docs/api.md` is generated (`tools/gen_api.py`, `make docs`, CONTRIBUTING.md, the file's first line) |
| timeout-setting | how settings work (`syncer/settings/`: defaults, the file for `APP_ENV`, `SYNCER_*` variables, the schema that types and checks them) |
| phone-column | how the database changes (`crm/db/migrations/README.md`: a new numbered migration, a `down()` that keeps every row, `EXPECTED` in `crm/db/version.py`), and the model and repository that follow it |

A second kind came from what the first couldn't show: on Terminal-Bench, the change jig had accepted
lost tasks by checking its work on the one example it had and stopping there (milestone 18). In these
tasks the project's own test is a special case, and the spec asks for more:

| task | the visible check | what the hidden tests ask |
|------|-------------------|---------------------------|
| sampler | one value of the parameter (a = 0) | six values, two with two peaks, by a Kolmogorov-Smirnov distance, and speed |
| rota | an easy week, which filling shifts in order manages | three weeks that a fill in order gets wrong (checked when they are made), and one that can't be filled |
| tiling | floors a few tiles long, where counting every tiling works | floors up to a billion tiles long, within a second |
| line-diff | five lines | the fewest edits, on cases where difflib's matching isn't the fewest, and 50,000-line files with repeated lines in 2 seconds |

The hidden tests check behaviour, not the way it was written. Where an instruction leaves room, each
reasonable reading passes: the tests were also run against a second solution that counts orders placed
but not yet invoiced as owed (credit-limit), and one that takes the timeout in whole seconds and allows 0
(timeout-setting).
