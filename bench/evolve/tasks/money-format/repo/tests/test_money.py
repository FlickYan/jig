import unittest

from money import format_money


class TestBasics(unittest.TestCase):
    def test_dollars(self):
        self.assertEqual(format_money(123456, "USD"), "$1,234.56")

    def test_yen(self):
        self.assertEqual(format_money(1234, "JPY"), "¥1,234")


if __name__ == "__main__":
    unittest.main()
