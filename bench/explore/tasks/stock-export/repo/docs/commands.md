# How commands work

- Each command is a module in `stock/commands/` with `configure(parser)` and `run(store, args, config)`,
  listed in `stock/commands/__init__.py`.
- A command returns what it wants to show, and `stock.output.emit` prints it: a table, or JSON with the
  global `--json` flag. Commands never print themselves.
- Commands that write files use `stock.files.write_csv`, which decides where files go and how money is
  written in them. Don't open files for writing anywhere else.
- Errors are `stock.errors.StockError` subclasses; `main` turns them into a message and an exit code.
