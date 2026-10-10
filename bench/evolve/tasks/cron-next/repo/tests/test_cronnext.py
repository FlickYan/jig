import unittest
from datetime import datetime

from cronnext import next_run


class TestBasics(unittest.TestCase):
    def test_every_minute(self):
        self.assertEqual(next_run("* * * * *", datetime(2026, 1, 1, 10, 30, 15)), datetime(2026, 1, 1, 10, 31))

    def test_daily(self):
        self.assertEqual(next_run("0 9 * * *", datetime(2026, 1, 1, 10, 0)), datetime(2026, 1, 2, 9, 0))


if __name__ == "__main__":
    unittest.main()
