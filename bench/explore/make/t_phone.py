"""phone-column: adding a field means following how this project changes its database.

What the agent must find: crm/db/migrations/README.md (a numbered migration with up() and down(), down()
undoing up() without losing data, the way 0002 rebuilds the table, and EXPECTED in crm/db/version.py bumped
so the app accepts the new schema), the dataclass in crm/models.py, and the explicit column lists in
crm/repository.py. A column added straight to 0001, or a migration the app refuses to start with, fails.
"""
from maketask import task

FILES = {
    "README.md": """
        # crm

        The shop's customer records, in SQLite. How to change the database: crm/db/migrations/README.md.
        """,
    "crm/__init__.py": "",
    "crm/models.py": """
        from dataclasses import dataclass


        @dataclass
        class Customer:
            id: int | None
            name: str
            email: str | None = None
        """,
    "crm/repository.py": """
        from crm.models import Customer

        COLUMNS = "id, name, email"


        def save(conn, customer):
            \"\"\"Inserts a new customer and returns it with its id.\"\"\"
            cursor = conn.execute("INSERT INTO customers (name, email) VALUES (?, ?)", (customer.name, customer.email))
            conn.commit()
            return Customer(cursor.lastrowid, customer.name, customer.email)


        def get(conn, customer_id):
            row = conn.execute(f"SELECT {COLUMNS} FROM customers WHERE id = ?", (customer_id,)).fetchone()
            return Customer(*row) if row else None
        """,
    "crm/app.py": """
        from crm.db import version


        def check_schema(conn):
            \"\"\"The app only runs on the schema it was written for.\"\"\"
            current = conn.execute("SELECT version FROM schema_version").fetchone()[0]
            if current != version.EXPECTED:
                raise RuntimeError(f"the database is at version {current}, the app needs {version.EXPECTED}: run the migrations")
        """,
    "crm/db/__init__.py": "",
    "crm/db/version.py": """
        EXPECTED = 2  # the schema version this code works with
        """,
    "crm/db/migrate.py": """
        \"\"\"Brings a database to a schema version by running migrations up or down, in order.\"\"\"
        import importlib
        import pkgutil
        import re

        from crm.db import migrations


        def available():
            \"\"\"(number, module) for every migration, in order.\"\"\"
            found = []
            for info in pkgutil.iter_modules(migrations.__path__):
                match = re.match(r"(\\d{4})_", info.name)
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
            \"\"\"Runs migrations up to `target` (default: the latest) or down to it.\"\"\"
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
        """,
    "crm/db/migrations/__init__.py": "",
    "crm/db/migrations/README.md": """
        # Changing the database

        - Never edit a migration that has been released: add a new one, numbered after the last
          (`0003_something.py`), with `up(conn)` and `down(conn)`.
        - `down()` must undo `up()` exactly and keep every row. SQLite can't always drop a column, so a
          migration that adds one rebuilds the table without it in `down()`, as 0002 does.
        - Then set `EXPECTED` in `crm/db/version.py` to the new number: the app refuses to start on any
          other version.
        - Models (crm/models.py) and the repository's column lists (crm/repository.py) follow the schema.
        """,
    "crm/db/migrations/0001_customers.py": """
        def up(conn):
            conn.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")


        def down(conn):
            conn.execute("DROP TABLE customers")
        """,
    "crm/db/migrations/0002_email.py": """
        def up(conn):
            conn.execute("ALTER TABLE customers ADD COLUMN email TEXT")


        def down(conn):
            conn.execute("CREATE TABLE customers_before (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            conn.execute("INSERT INTO customers_before (id, name) SELECT id, name FROM customers")
            conn.execute("DROP TABLE customers")
            conn.execute("ALTER TABLE customers_before RENAME TO customers")
        """,
    "tests/__init__.py": "",
    "tests/test_repository.py": """
        import sqlite3
        import unittest

        from crm import repository
        from crm.app import check_schema
        from crm.db.migrate import migrate
        from crm.models import Customer


        class RepositoryTest(unittest.TestCase):
            def test_save_and_get(self):
                conn = sqlite3.connect(":memory:")
                migrate(conn)
                check_schema(conn)
                saved = repository.save(conn, Customer(None, "Ada", "ada@example.com"))
                self.assertEqual(repository.get(conn, saved.id), saved)
        """,
}

SOLUTION = {
    "crm/models.py": """
        from dataclasses import dataclass


        @dataclass
        class Customer:
            id: int | None
            name: str
            email: str | None = None
            phone: str | None = None
        """,
    "crm/repository.py": """
        from crm.models import Customer

        COLUMNS = "id, name, email, phone"


        def save(conn, customer):
            \"\"\"Inserts a new customer and returns it with its id.\"\"\"
            cursor = conn.execute("INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)", (customer.name, customer.email, customer.phone))
            conn.commit()
            return Customer(cursor.lastrowid, customer.name, customer.email, customer.phone)


        def get(conn, customer_id):
            row = conn.execute(f"SELECT {COLUMNS} FROM customers WHERE id = ?", (customer_id,)).fetchone()
            return Customer(*row) if row else None
        """,
    "crm/db/version.py": """
        EXPECTED = 3  # the schema version this code works with
        """,
    "crm/db/migrations/0003_phone.py": """
        def up(conn):
            conn.execute("ALTER TABLE customers ADD COLUMN phone TEXT")


        def down(conn):
            conn.execute("CREATE TABLE customers_before (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)")
            conn.execute("INSERT INTO customers_before (id, name, email) SELECT id, name, email FROM customers")
            conn.execute("DROP TABLE customers")
            conn.execute("ALTER TABLE customers_before RENAME TO customers")
        """,
}

HIDDEN = """
    import sqlite3
    import unittest

    from crm import repository
    from crm.app import check_schema
    from crm.db import version
    from crm.db.migrate import available, migrate
    from crm.models import Customer


    def columns(conn):
        return [row[1] for row in conn.execute("PRAGMA table_info(customers)")]


    class PhoneTest(unittest.TestCase):
        def setUp(self):
            self.conn = sqlite3.connect(":memory:")

        def test_a_new_migration_and_the_version_the_app_expects(self):
            migrate(self.conn)
            self.assertEqual(columns(self.conn), ["id", "name", "email", "phone"])
            self.assertEqual([number for number, _ in available()], [1, 2, 3])
            self.assertEqual(version.EXPECTED, 3)
            check_schema(self.conn)

        def test_the_released_migrations_are_unchanged(self):
            migrate(self.conn, target=2)
            self.assertEqual(columns(self.conn), ["id", "name", "email"])

        def test_customers_keep_their_phone(self):
            migrate(self.conn)
            saved = repository.save(self.conn, Customer(None, "Ada", "ada@example.com", "+44 20 7946 0000"))
            self.assertEqual(repository.get(self.conn, saved.id).phone, "+44 20 7946 0000")
            plain = repository.save(self.conn, Customer(None, "Bo"))
            self.assertIsNone(repository.get(self.conn, plain.id).phone)

        def test_down_keeps_every_row(self):
            migrate(self.conn, target=2)
            self.conn.execute("INSERT INTO customers (name, email) VALUES ('Cy', 'cy@example.com')")
            migrate(self.conn)
            self.conn.execute("UPDATE customers SET phone = '555' WHERE name = 'Cy'")
            migrate(self.conn, target=2)
            self.assertEqual(columns(self.conn), ["id", "name", "email"])
            self.assertEqual(self.conn.execute("SELECT name, email FROM customers").fetchall(), [("Cy", "cy@example.com")])
            migrate(self.conn)
            self.assertEqual(self.conn.execute("SELECT name, email, phone FROM customers").fetchall(), [("Cy", "cy@example.com", None)])
"""

task(
    "phone-column",
    "Customers can have a phone number now (it's optional). Store it with each customer.",
    ["python", "feature", "database", "exploration"],
    FILES,
    HIDDEN,
    SOLUTION,
)
