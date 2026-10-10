import unittest

from durations import parse_duration


class TestSpec(unittest.TestCase):
    def test_units_and_case(self):
        self.assertEqual(parse_duration("1H"), 3600)
        self.assertEqual(parse_duration("2D"), 172800)
        self.assertEqual(parse_duration("3M 4S"), 184)

    def test_long_names(self):
        self.assertEqual(parse_duration("2 hours 5 mins"), 7500)
        self.assertEqual(parse_duration("1 day"), 86400)
        self.assertEqual(parse_duration("3seconds"), 3)
        self.assertEqual(parse_duration("1 Minute 1 Sec"), 61)

    def test_separators(self):
        self.assertEqual(parse_duration("1h, 30m"), 5400)
        self.assertEqual(parse_duration("1 hour and 30 minutes"), 5400)
        self.assertEqual(parse_duration("1h,30m"), 5400)

    def test_fractions_and_rounding(self):
        self.assertEqual(parse_duration("1.5h"), 5400)
        self.assertEqual(parse_duration("0.5s"), 1)
        self.assertEqual(parse_duration("1.4s"), 1)
        self.assertEqual(parse_duration("2.5s"), 3)

    def test_plain_number(self):
        self.assertEqual(parse_duration("90"), 90)
        self.assertEqual(parse_duration("  45  "), 45)
        with self.assertRaises(ValueError):
            parse_duration("1h 30")

    def test_each_unit_once_any_order(self):
        self.assertEqual(parse_duration("30m1h"), 5400)
        for text in ["1h 2h", "1h 2hours", "5m 1 min"]:
            with self.assertRaises(ValueError):
                parse_duration(text)

    def test_blank_and_bad_input(self):
        for text in ["", "   ", "h", "-5s", "1x", "1h and", "abc", "1..5h"]:
            with self.assertRaises(ValueError, msg=text):
                parse_duration(text)

    def test_error_message_quotes_the_input(self):
        with self.assertRaises(ValueError) as caught:
            parse_duration("1h 2h")
        self.assertTrue("'1h 2h'" in str(caught.exception) or '"1h 2h"' in str(caught.exception))


if __name__ == "__main__":
    unittest.main()
