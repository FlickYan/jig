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
