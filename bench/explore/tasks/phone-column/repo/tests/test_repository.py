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
