import unittest
from datetime import date

from workdays import add_business_days, business_days_between, holidays_in


class TestBasics(unittest.TestCase):
    def test_a_weekend(self):
        self.assertEqual(add_business_days(date(2024, 1, 5), 1, []), date(2024, 1, 8))

    def test_a_holiday(self):
        self.assertEqual(holidays_in(2024, ["07-04"]), [date(2024, 7, 4)])
        self.assertEqual(business_days_between(date(2024, 7, 3), date(2024, 7, 5), ["07-04"]), 1)


if __name__ == "__main__":
    unittest.main()
