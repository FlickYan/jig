import hashlib
import unittest

from calendar_utils import add_months, days_in_month, is_leap_year

# The visible tests must pass unchanged: the task is to fix the code, not the tests.
VISIBLE_TESTS_SHA256 = "1dbe81454f84badb7219becf0a2207c09378b551704870509107442721705f1d"


class HiddenTest(unittest.TestCase):
    def test_visible_tests_are_unchanged(self):
        with open("tests/test_calendar_utils.py", "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), VISIBLE_TESTS_SHA256)

    def test_visible_tests_pass(self):
        suite = unittest.defaultTestLoader.discover("tests", top_level_dir=".")
        result = unittest.TextTestRunner(verbosity=0).run(suite)
        self.assertTrue(result.wasSuccessful())
        self.assertGreaterEqual(result.testsRun, 6)

    def test_more_leap_years(self):
        self.assertEqual([y for y in (1600, 1700, 1996, 2000, 2004, 2200, 2400) if is_leap_year(y)], [1600, 1996, 2000, 2004, 2400])

    def test_going_back(self):
        self.assertEqual(add_months(2024, 3, 31, -1), (2024, 2, 29))
        self.assertEqual(add_months(2024, 1, 10, -1), (2023, 12, 10))
        self.assertEqual(add_months(2024, 5, 31, -15), (2023, 2, 28))

    def test_whole_years(self):
        self.assertEqual(add_months(2020, 2, 29, 12), (2021, 2, 28))
        self.assertEqual(add_months(2020, 7, 4, 48), (2024, 7, 4))
        self.assertEqual(days_in_month(2000, 2), 29)


if __name__ == "__main__":
    unittest.main()
