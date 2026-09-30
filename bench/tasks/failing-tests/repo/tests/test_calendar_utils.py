import unittest

from calendar_utils import add_months, days_in_month, is_leap_year


class LeapYearTest(unittest.TestCase):
    def test_leap_years(self):
        self.assertTrue(is_leap_year(2024))
        self.assertTrue(is_leap_year(2000))
        self.assertFalse(is_leap_year(2023))
        self.assertFalse(is_leap_year(1900))


class DaysInMonthTest(unittest.TestCase):
    def test_february(self):
        self.assertEqual(days_in_month(2024, 2), 29)
        self.assertEqual(days_in_month(2100, 2), 28)

    def test_other_months(self):
        self.assertEqual(days_in_month(2023, 4), 30)
        self.assertEqual(days_in_month(2023, 12), 31)


class AddMonthsTest(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(add_months(2024, 3, 15, 2), (2024, 5, 15))

    def test_clamps_to_the_end_of_the_month(self):
        self.assertEqual(add_months(2024, 1, 31, 1), (2024, 2, 29))

    def test_crosses_into_the_next_year(self):
        self.assertEqual(add_months(2023, 12, 15, 1), (2024, 1, 15))
        self.assertEqual(add_months(2023, 11, 30, 3), (2024, 2, 29))
