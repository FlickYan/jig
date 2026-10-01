---
name: db-migrations
description: This project's rules for database migrations (file names, up and down sections, how to name indexes, constraints and foreign keys). Use whenever you add or change a migration in migrations/.
---

# Database migrations

Migrations are plain SQL files in `migrations/`, applied in order by `app/db.py`.

## Writing one

1. Name the file `NNNN_<what_it_does>.sql`: the next free four-digit number, then a short snake_case summary.
2. Write a `-- migrate:up` section, then a `-- migrate:down` section that undoes exactly what the up section did.
3. Never change a migration that is already committed; add a new one instead.

## Naming

Name every index and constraint explicitly; the monitoring dashboards and the on-call runbooks look them up by these prefixes, so other names (like `idx_...`) break them:

- Indexes: `ix_<table>_<column>`, with several columns joined by underscores: `ix_orders_user_id_created_at`.
- Unique constraints: `uq_<table>_<column>`.
- Foreign keys: `fk_<table>_<column>`.

## Before you finish

Run the tests: `python3 -m unittest`.
