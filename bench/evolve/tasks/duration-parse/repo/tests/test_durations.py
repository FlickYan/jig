import unittest

from durations import parse_duration


class TestBasics(unittest.TestCase):
    def test_hours_and_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_seconds(self):
        self.assertEqual(parse_duration("90s"), 90)

    def test_days_and_hours(self):
        self.assertEqual(parse_duration("2d 3h"), 183600)


if __name__ == "__main__":
    unittest.main()
