import unittest

from app import db


class MigrationsTest(unittest.TestCase):
    def test_migrate_and_roll_back(self):
        conn = db.connect()
        db.migrate(conn)
        self.assertEqual(db.version(conn), len(db.migration_files()))
        conn.execute("INSERT INTO users (email, name) VALUES ('ada@example.com', 'Ada')")
        conn.execute("INSERT INTO orders (user_id, total_cents) VALUES (1, 1250)")
        db.rollback(conn, steps=db.version(conn))
        self.assertEqual(db.version(conn), 0)
        tables = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        self.assertEqual(tables, [])

    def test_every_migration_has_both_sections(self):
        for path in db.migration_files():
            up, down = db.sections(path)
            self.assertTrue(up and down, path.name)


if __name__ == "__main__":
    unittest.main()
