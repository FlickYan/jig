"""Brings a database to a schema version by running migrations up or down, in order."""
import importlib
import pkgutil
import re

from crm.db import migrations


def available():
    """(number, module) for every migration, in order."""
    found = []
    for info in pkgutil.iter_modules(migrations.__path__):
        match = re.match(r"(\d{4})_", info.name)
        if match:
            found.append((int(match.group(1)), importlib.import_module(f"crm.db.migrations.{info.name}")))
    return sorted(found, key=lambda item: item[0])


def current(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT version FROM schema_version").fetchone()
    if row is None:
        conn.execute("INSERT INTO schema_version VALUES (0)")
        return 0
    return row[0]


def migrate(conn, target=None):
    """Runs migrations up to `target` (default: the latest) or down to it."""
    steps = available()
    target = steps[-1][0] if target is None else target
    now = current(conn)
    for number, module in steps:
        if now < number <= target:
            module.up(conn)
            conn.execute("UPDATE schema_version SET version = ?", (number,))
    for number, module in reversed(steps):
        if target < number <= now:
            module.down(conn)
            conn.execute("UPDATE schema_version SET version = ?", (number - 1,))
    conn.commit()
