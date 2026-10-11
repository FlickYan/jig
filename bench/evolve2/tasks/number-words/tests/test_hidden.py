import unittest
from decimal import Decimal

from words import from_words, to_cheque, to_ordinal, to_words


class TestSpec(unittest.TestCase):
    def test_words(self):
        for n, text in [(0, 'zero'), (7, 'seven'), (13, 'thirteen'), (20, 'twenty'), (21, 'twenty-one'), (42, 'forty-two'), (99, 'ninety-nine'), (100, 'one hundred'), (101, 'one hundred one'), (110, 'one hundred ten'), (115, 'one hundred fifteen'), (342, 'three hundred forty-two'), (999, 'nine hundred ninety-nine'), (1000, 'one thousand'), (1001, 'one thousand one'), (1100, 'one thousand one hundred'), (1234, 'one thousand two hundred thirty-four'), (10000, 'ten thousand'), (100000, 'one hundred thousand'), (1000001, 'one million one'), (1234567, 'one million two hundred thirty-four thousand five hundred sixty-seven'), (2000000000, 'two billion'), (1000000000000, 'one trillion'), (999999999999999, 'nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine'), (-42, 'minus forty-two'), (-1000, 'minus one thousand'), (40, 'forty'), (14, 'fourteen'), (18, 'eighteen'), (1000010, 'one million ten'), (501000000, 'five hundred one million')]:
            with self.subTest(n=n):
                self.assertEqual(to_words(n), text)

    def test_ordinals(self):
        for n, text in [(0, 'zeroth'), (1, 'first'), (2, 'second'), (3, 'third'), (4, 'fourth'), (5, 'fifth'), (8, 'eighth'), (9, 'ninth'), (11, 'eleventh'), (12, 'twelfth'), (13, 'thirteenth'), (20, 'twentieth'), (21, 'twenty-first'), (42, 'forty-second'), (90, 'ninetieth'), (100, 'one hundredth'), (101, 'one hundred first'), (1000, 'one thousandth'), (1003, 'one thousand third'), (1000000, 'one millionth'), (1000012, 'one million twelfth'), (3000000000, 'three billionth'), (15, 'fifteenth'), (40, 'fortieth'), (99, 'ninety-ninth'), (112, 'one hundred twelfth')]:
            with self.subTest(n=n):
                self.assertEqual(to_ordinal(n), text)

    def test_reading_words(self):
        for text, n in [('zero', 0), ('minus forty-two', -42), ('one million one', 1000001), ('nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine', 999999999999999), ('eighty-eight thousand eight', 88008), ('seventeen', 17)]:
            with self.subTest(text=text):
                self.assertEqual(from_words(text), n)

    def test_reading_only_what_to_words_writes(self):
        for text in ['forty two', 'Forty-two', 'one hundred and five', 'fourty', 'twenty-zero', 'one thousand thousand', 'ten hundred', 'eleven hundred', 'minus zero', ' five', 'five ', '', 'one  million', 'a hundred', 'one quadrillion', 'one thousand trillion', 'hundred', 'thousand', 'one hundred hundred', 'two zero', 'zero zero', 'minus', 'minus minus five', 'twenty-ten', 'ninety-', '-five', 'one-hundred', 'thousand one']:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    from_words(text)

    def test_round_trip(self):
        for n in list(range(-1200, 2500, 7)) + [10 ** k + j for k in range(3, 15) for j in (-1, 0, 1, 999)]:
            self.assertEqual(from_words(to_words(n)), n)

    def test_british_words(self):
        for n, text in [(5, 'five'), (21, 'twenty-one'), (100, 'one hundred'), (105, 'one hundred and five'), (120, 'one hundred and twenty'), (342, 'three hundred and forty-two'), (1000, 'one thousand'), (1005, 'one thousand and five'), (1100, 'one thousand one hundred'), (1105, 'one thousand one hundred and five'), (1150, 'one thousand one hundred and fifty'), (2000050, 'two million and fifty'), (101000, 'one hundred and one thousand'), (342021, 'three hundred and forty-two thousand and twenty-one'), (1000001, 'one million and one'), (999999999999999, 'nine hundred and ninety-nine trillion nine hundred and ninety-nine billion nine hundred and ninety-nine million nine hundred and ninety-nine thousand nine hundred and ninety-nine'), (-105, 'minus one hundred and five'), (1000100, 'one million one hundred'), (1000000, 'one million'), (110000000, 'one hundred and ten million')]:
            with self.subTest(n=n):
                self.assertEqual(to_words(n, "uk"), text)
                self.assertEqual(from_words(text, "uk"), n)

    def test_british_ordinals(self):
        for n, text in [(101, 'one hundred and first'), (1001, 'one thousand and first'), (1000003, 'one million and third'), (120, 'one hundred and twentieth'), (112, 'one hundred and twelfth'), (100, 'one hundredth'), (1000, 'one thousandth')]:
            with self.subTest(n=n):
                self.assertEqual(to_ordinal(n, "uk"), text)

    def test_reading_british_only_as_it_is_written(self):
        for text in ['one hundred five', 'one thousand five', 'one thousand and one hundred', 'and five', 'one hundred and', 'five and', 'one and thousand', 'one hundred and and five', 'one million fifty']:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    from_words(text, "uk")
        with self.assertRaises(ValueError):
            from_words("one hundred and five")  # US style, the default, has no "and"

    def test_british_round_trip(self):
        for n in list(range(-1200, 2500, 7)) + [10 ** k + j for k in range(3, 15) for j in (-1, 0, 1, 50, 999)]:
            self.assertEqual(from_words(to_words(n, "uk"), "uk"), n)

    def test_styles(self):
        for call in (lambda: to_words(5, "fr"), lambda: to_ordinal(5, "UK"), lambda: from_words("five", "british")):
            with self.assertRaises(ValueError):
                call()

    def test_cheques(self):
        for amount, text in [('1234.50', 'one thousand two hundred thirty-four dollars and fifty cents'), ('1', 'one dollar and no cents'), ('0.01', 'zero dollars and one cent'), ('21.21', 'twenty-one dollars and twenty-one cents'), ('2.5', 'two dollars and fifty cents'), ('0', 'zero dollars and no cents'), ('0.99', 'zero dollars and ninety-nine cents'), ('1000000000000.01', 'one trillion dollars and one cent')]:
            with self.subTest(amount=amount):
                self.assertEqual(to_cheque(amount), text)
        for amount, text in [('1E+3', 'one thousand dollars and no cents'), ('0.10', 'zero dollars and ten cents'), ('1000000.99', 'one million dollars and ninety-nine cents'), ('7', 'seven dollars and no cents')]:
            with self.subTest(decimal=amount):
                self.assertEqual(to_cheque(Decimal(amount)), text)
        self.assertEqual(to_cheque(1), "one dollar and no cents")
        self.assertEqual(to_cheque(21), "twenty-one dollars and no cents")

    def test_amounts_that_cant_be_written_on_a_cheque(self):
        for amount in ['-5', '1,234', '+5', ' 5', '5.', '.5', '1.234', '1000000000000000', '1e3', ''] + [Decimal("1.234"), Decimal("-1"), Decimal("NaN"), Decimal("1E+15"), -1]:
            with self.subTest(amount=amount):
                with self.assertRaises(ValueError):
                    to_cheque(amount)
        for amount in (5.0, 0.5, True, None, [1]):
            with self.subTest(amount=amount):
                with self.assertRaises(TypeError):
                    to_cheque(amount)

    def test_types(self):
        for value in (True, False, 1.0, "5", None):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    to_words(value)
                with self.assertRaises(TypeError):
                    to_ordinal(value)
        with self.assertRaises(TypeError):
            from_words(5)

    def test_range(self):
        for n in (10 ** 15, -10 ** 15, 10 ** 20):
            with self.subTest(n=n):
                with self.assertRaises(ValueError):
                    to_words(n)
        for n in (-1, 10 ** 15):
            with self.subTest(n=n):
                with self.assertRaises(ValueError):
                    to_ordinal(n)


if __name__ == "__main__":
    unittest.main()
