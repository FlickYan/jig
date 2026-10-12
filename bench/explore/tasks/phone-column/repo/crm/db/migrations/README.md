# Changing the database

- Never edit a migration that has been released: add a new one, numbered after the last
  (`0003_something.py`), with `up(conn)` and `down(conn)`.
- `down()` must undo `up()` exactly and keep every row. SQLite can't always drop a column, so a
  migration that adds one rebuilds the table without it in `down()`, as 0002 does.
- Then set `EXPECTED` in `crm/db/version.py` to the new number: the app refuses to start on any
  other version.
- Models (crm/models.py) and the repository's column lists (crm/repository.py) follow the schema.
