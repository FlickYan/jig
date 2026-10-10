import unittest
from datetime import datetime

from cronnext import next_run


class TestSpec(unittest.TestCase):
    def test_lists_ranges_steps(self):
        self.assertEqual(next_run("*/15 * * * *", datetime(2026, 3, 1, 10, 16)), datetime(2026, 3, 1, 10, 30))
        self.assertEqual(next_run("1,15,30-40/5 * * * *", datetime(2026, 3, 1, 10, 31)), datetime(2026, 3, 1, 10, 35))
        self.assertEqual(next_run("0 8-18/4 * * *", datetime(2026, 3, 1, 12, 1)), datetime(2026, 3, 1, 16, 0))

    def test_names(self):
        # 2026-03-02 is a Monday.
        self.assertEqual(next_run("0 9 * * mon-fri", datetime(2026, 2, 28, 12, 0)), datetime(2026, 3, 2, 9, 0))
        self.assertEqual(next_run("0 0 1 JAN,jul *", datetime(2026, 2, 1)), datetime(2026, 7, 1))

    def test_sunday_is_0_and_7(self):
        # 2026-03-08 is a Sunday.
        self.assertEqual(next_run("0 0 * * 7", datetime(2026, 3, 2)), datetime(2026, 3, 8))
        self.assertEqual(next_run("0 0 * * 0", datetime(2026, 3, 2)), datetime(2026, 3, 8))
        self.assertEqual(next_run("0 0 * * 5-7", datetime(2026, 3, 2)), datetime(2026, 3, 6))

    def test_day_or_rule(self):
        # Either the 15th or a Monday: from Tuesday 2026-03-03, Monday 2026-03-09 comes first.
        self.assertEqual(next_run("0 9 15 * MON", datetime(2026, 3, 3)), datetime(2026, 3, 9, 9, 0))
        # Only the day of month restricted: the weekday doesn't matter.
        self.assertEqual(next_run("0 9 15 * *", datetime(2026, 3, 3)), datetime(2026, 3, 15, 9, 0))
        # Only the weekday restricted.
        self.assertEqual(next_run("0 9 * * MON", datetime(2026, 3, 10)), datetime(2026, 3, 16, 9, 0))

    def test_strictly_after(self):
        self.assertEqual(next_run("30 10 * * *", datetime(2026, 1, 1, 10, 30)), datetime(2026, 1, 2, 10, 30))
        self.assertEqual(next_run("30 10 * * *", datetime(2026, 1, 1, 10, 29, 59, 999)), datetime(2026, 1, 1, 10, 30))

    def test_leap_day(self):
        self.assertEqual(next_run("0 0 29 2 *", datetime(2026, 3, 1)), datetime(2028, 2, 29))

    def test_malformed(self):
        for bad in ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "* * * FOO *", "* * * * SUNDAY", "a b c d e"]:
            with self.assertRaises(ValueError, msg=bad):
                next_run(bad, datetime(2026, 1, 1))

    def test_never(self):
        with self.assertRaises(ValueError):
            next_run("0 0 30 2 *", datetime(2026, 1, 1))
        with self.assertRaises(ValueError):
            next_run("0 0 31 4,6,9,11 *", datetime(2026, 1, 1))


if __name__ == "__main__":
    unittest.main()
