import unittest
from datetime import date

from recurrence import occurrences


class TestBasics(unittest.TestCase):
    def test_daily(self):
        self.assertEqual(occurrences("FREQ=DAILY;COUNT=3", date(2024, 1, 1)), [date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3)])

    def test_weekly_on_days(self):
        self.assertEqual(occurrences("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3", date(2024, 1, 1)), [date(2024, 1, 1), date(2024, 1, 3), date(2024, 1, 8)])

    def test_invalid(self):
        with self.assertRaises(ValueError):
            occurrences("FREQ=SOMETIMES", date(2024, 1, 1))


if __name__ == "__main__":
    unittest.main()
