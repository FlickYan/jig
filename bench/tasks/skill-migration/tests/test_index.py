import unittest

from app import db


def indexes(conn):
    """Name and columns of every index that isn't created automatically."""
    names = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")]
    return {name: [row[2] for row in conn.execute(f"PRAGMA index_info('{name}')")] for name in names}


class OrdersIndexTest(unittest.TestCase):
    def test_one_new_migration(self):
        names = [path.name for path in db.migration_files()]
        self.assertEqual(len(names), 3, names)
        self.assertEqual(names[:2], ["0001_create_users.sql", "0002_create_orders.sql"])

    def test_index_follows_the_naming_rule(self):
        conn = db.connect()
        db.migrate(conn)
        self.assertEqual(indexes(conn), {"ix_orders_user_id": ["user_id"]})

    def test_rolls_back_cleanly(self):
        conn = db.connect()
        db.migrate(conn)
        db.rollback(conn)
        self.assertEqual(indexes(conn), {})
        self.assertEqual(db.version(conn), 2)
        tables = sorted(row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"))
        self.assertEqual(tables, ["orders", "users"])


if __name__ == "__main__":
    unittest.main()
