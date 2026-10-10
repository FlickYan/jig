import unittest

from money import format_money

NB = "\u00a0"
NNB = "\u202f"


class TestSpec(unittest.TestCase):
    def test_decimals(self):
        self.assertEqual(format_money(5, "USD"), "$0.05")
        self.assertEqual(format_money(1234567, "BHD"), "BHD 1,234.567")
        self.assertEqual(format_money(50, "KRW"), "₩50")
        self.assertEqual(format_money(100, "GBP"), "£1.00")

    def test_de_and_fr(self):
        self.assertEqual(format_money(123456, "EUR", "de"), f"1.234,56{NB}€")
        self.assertEqual(format_money(123456, "EUR", "fr"), f"1{NNB}234,56{NB}€")
        self.assertEqual(format_money(1234567, "KWD", "de"), f"1.234,567{NB}KWD")
        self.assertEqual(format_money(99, "JPY", "fr"), f"99{NB}¥")

    def test_grouping(self):
        self.assertEqual(format_money(123456789, "USD"), "$1,234,567.89")
        self.assertEqual(format_money(99900, "USD"), "$999.00")
        self.assertEqual(format_money(100000000, "JPY", "de"), f"100.000.000{NB}¥")

    def test_negative(self):
        self.assertEqual(format_money(-500, "USD"), "-$5.00")
        self.assertEqual(format_money(-500, "EUR", "de"), f"-5,00{NB}€")
        self.assertEqual(format_money(-500, "USD", accounting=True), "($5.00)")
        self.assertEqual(format_money(-123456, "EUR", "fr", accounting=True), f"(1{NNB}234,56{NB}€)")
        self.assertEqual(format_money(500, "USD", accounting=True), "$5.00")

    def test_zero(self):
        self.assertEqual(format_money(-0, "USD"), "$0.00")
        self.assertEqual(format_money(0, "EUR", "de", accounting=True), f"0,00{NB}€")

    def test_errors(self):
        for args in [(100, "XYZ"), (100, "USD", "es"), (1.5, "USD"), (True, "USD"), ("100", "USD")]:
            with self.assertRaises(ValueError, msg=repr(args)):
                format_money(*args)


if __name__ == "__main__":
    unittest.main()
