"""Applies the SQL migrations in migrations/ to a SQLite database.

The database's user_version is the number of the last migration applied to it.
"""

import re
import sqlite3
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
FILE_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
SECTIONS = re.compile(r"\s*-- migrate:up\n(.*)\n-- migrate:down\n(.*)", re.S)


def connect(path=":memory:"):
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def migration_files():
    """The migration files, in order. Their numbers must run 0001, 0002, ... without gaps."""
    files = sorted(p for p in MIGRATIONS.iterdir() if p.suffix == ".sql")
    for number, path in enumerate(files, start=1):
        match = FILE_NAME.match(path.name)
        if not match or int(match.group(1)) != number:
            raise ValueError(f"expected migration {number:04d}_<name>.sql, found {path.name}")
    return files


def sections(path):
    """The up and down SQL of a migration file."""
    match = SECTIONS.fullmatch(path.read_text())
    if not match:
        raise ValueError(f"{path.name} needs a '-- migrate:up' section followed by a '-- migrate:down' section")
    return match.group(1).strip(), match.group(2).strip()


def version(conn):
    return conn.execute("PRAGMA user_version").fetchone()[0]


def migrate(conn):
    """Applies every migration the database doesn't have yet."""
    for number, path in enumerate(migration_files(), start=1):
        if number > version(conn):
            up, _ = sections(path)
            conn.executescript(up)
            conn.execute(f"PRAGMA user_version = {number}")
    conn.commit()


def rollback(conn, steps=1):
    """Undoes the last `steps` migrations."""
    files = migration_files()
    for _ in range(steps):
        current = version(conn)
        if current == 0:
            break
        _, down = sections(files[current - 1])
        conn.executescript(down)
        conn.execute(f"PRAGMA user_version = {current - 1}")
    conn.commit()
