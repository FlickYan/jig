import importlib.util
from maketask import task

spec = importlib.util.spec_from_file_location("w", "words_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
WORDS = [0, 7, 13, 20, 21, 42, 99, 100, 101, 110, 115, 342, 999, 1000, 1001, 1100, 1234, 10000, 100000, 1000001, 1234567, 2000000000, 1000000000000, 999999999999999, -42, -1000, 40, 14, 18, 1000010, 501000000]
ORDINALS = [0, 1, 2, 3, 4, 5, 8, 9, 11, 12, 13, 20, 21, 42, 90, 100, 101, 1000, 1003, 1000000, 1000012, 3000000000, 15, 40, 99, 112]
BAD = ["forty two", "Forty-two", "one hundred and five", "fourty", "twenty-zero", "one thousand thousand", "ten hundred", "eleven hundred", "minus zero",
       " five", "five ", "", "one  million", "a hundred", "one quadrillion", "one thousand trillion", "hundred", "thousand", "one hundred hundred",
       "two zero", "zero zero", "minus", "minus minus five", "twenty-ten", "ninety-", "-five", "one-hundred", "thousand one"]
for text in BAD:
    try:
        m.from_words(text); raise SystemExit(f"accepted {text!r}")
    except ValueError:
        pass
UK = [5, 21, 100, 105, 120, 342, 1000, 1005, 1100, 1105, 1150, 2000050, 101000, 342021, 1000001, 999999999999999, -105, 1000100, 1000000, 110000000]
UK_ORDINALS = [101, 1001, 1000003, 120, 112, 100, 1000]
UK_BAD = ["one hundred five", "one thousand five", "one thousand and one hundred", "and five", "one hundred and", "five and", "one and thousand", "one hundred and and five", "one million fifty"]
CHEQUES = ["1234.50", "1", "0.01", "21.21", "2.5", "0", "0.99", "1000000000000.01"]
CHEQUE_DECIMALS = [("1E+3", None), ("0.10", None), ("1000000.99", None), ("7", None)]
BAD_CHEQUES = ["-5", "1,234", "+5", " 5", "5.", ".5", "1.234", "1000000000000000", "1e3", ""]
from decimal import Decimal
for bad in BAD_CHEQUES + [Decimal("1.234"), Decimal("-1"), Decimal("NaN"), Decimal("1E+15")]:
    try:
        m.to_cheque(bad); raise SystemExit(f"accepted cheque {bad!r}")
    except ValueError:
        pass
for text in UK_BAD:
    try:
        m.from_words(text, "uk"); raise SystemExit(f"accepted uk {text!r}")
    except ValueError:
        pass
VALID_TEXT = ["zero", "minus forty-two", "one million one", "nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine", "eighty-eight thousand eight", "seventeen"]

hidden = f'''
import unittest
from decimal import Decimal

from words import from_words, to_cheque, to_ordinal, to_words


class TestSpec(unittest.TestCase):
    def test_words(self):
        for n, text in {[(n, m.to_words(n)) for n in WORDS]!r}:
            with self.subTest(n=n):
                self.assertEqual(to_words(n), text)

    def test_ordinals(self):
        for n, text in {[(n, m.to_ordinal(n)) for n in ORDINALS]!r}:
            with self.subTest(n=n):
                self.assertEqual(to_ordinal(n), text)

    def test_reading_words(self):
        for text, n in {[(t, m.from_words(t)) for t in VALID_TEXT]!r}:
            with self.subTest(text=text):
                self.assertEqual(from_words(text), n)

    def test_reading_only_what_to_words_writes(self):
        for text in {BAD!r}:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    from_words(text)

    def test_round_trip(self):
        for n in list(range(-1200, 2500, 7)) + [10 ** k + j for k in range(3, 15) for j in (-1, 0, 1, 999)]:
            self.assertEqual(from_words(to_words(n)), n)

    def test_british_words(self):
        for n, text in {[(n, m.to_words(n, "uk")) for n in UK]!r}:
            with self.subTest(n=n):
                self.assertEqual(to_words(n, "uk"), text)
                self.assertEqual(from_words(text, "uk"), n)

    def test_british_ordinals(self):
        for n, text in {[(n, m.to_ordinal(n, "uk")) for n in UK_ORDINALS]!r}:
            with self.subTest(n=n):
                self.assertEqual(to_ordinal(n, "uk"), text)

    def test_reading_british_only_as_it_is_written(self):
        for text in {UK_BAD!r}:
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
        for amount, text in {[(a, m.to_cheque(a)) for a in CHEQUES]!r}:
            with self.subTest(amount=amount):
                self.assertEqual(to_cheque(amount), text)
        for amount, text in {[(d, m.to_cheque(Decimal(d))) for d, _ in CHEQUE_DECIMALS]!r}:
            with self.subTest(decimal=amount):
                self.assertEqual(to_cheque(Decimal(amount)), text)
        self.assertEqual(to_cheque(1), "one dollar and no cents")
        self.assertEqual(to_cheque(21), "twenty-one dollars and no cents")

    def test_amounts_that_cant_be_written_on_a_cheque(self):
        for amount in {BAD_CHEQUES!r} + [Decimal("1.234"), Decimal("-1"), Decimal("NaN"), Decimal("1E+15"), -1]:
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
'''

SPEC = r'''
# Numbers in words

`to_words(n)`, `to_ordinal(n)` and `from_words(text)`, in `words.py`, write and read whole numbers in
English words, and `to_cheque(amount)` writes an amount of money as a cheque does.

## to_words(n, style="us")

1. `n` is an `int` from -999,999,999,999,999 to 999,999,999,999,999; a larger one raises `ValueError`,
   and anything that isn't an `int` raises `TypeError` (`True` and `False` aren't numbers here). `style`
   is `"us"` (the default) or `"uk"`; any other raises `ValueError`.
2. 0 is `zero`, and a negative number is `minus` and the words for its absolute value.
3. 1 to 19 are `one`, `two`, `three`, `four`, `five`, `six`, `seven`, `eight`, `nine`, `ten`, `eleven`,
   `twelve`, `thirteen`, `fourteen`, `fifteen`, `sixteen`, `seventeen`, `eighteen` and `nineteen`. The
   tens are `twenty`, `thirty`, `forty`, `fifty`, `sixty`, `seventy`, `eighty` and `ninety`; from 21 to
   99, a number that isn't a ten joins its ten and its unit with a hyphen: `forty-two`.
4. From 100 to 999: the hundreds digit, `hundred`, and then the rest unless it is zero: `three hundred`,
   `three hundred five`, `three hundred forty-two`. In US style there is never an `and`.
5. Larger numbers are written in groups of three digits from the left, each followed by its scale:
   `thousand`, `million`, `billion` and `trillion` (10^3, 10^6, 10^9 and 10^12). A group that is zero is
   left out: 1000001 is `one million one`, and 1234567 is `one million two hundred thirty-four thousand
   five hundred sixty-seven`. So 1100 is `one thousand one hundred`, never `eleven hundred`.
6. Words are separated by single spaces, and are all lower-case.
7. In UK style, the words are the same with `and` in two places: after `hundred` when the rest of its
   group of three digits isn't zero (`one hundred and five`, `three hundred and forty-two thousand`), and
   before the last group when it is less than 100 and there is a group above it (`one thousand and
   five`, `two million and fifty`). So 1105 is `one thousand one hundred and five`, and 1100 is still
   `one thousand one hundred`.

## to_ordinal(n, style="us")

8. For an `int` from 0 to 999,999,999,999,999 (`TypeError` and `ValueError` as in rule 1, and
   `ValueError` for a negative number too): the words for `n` in the style, with the last word made
   ordinal. `one` becomes `first`, `two` `second`, `three` `third`, `five` `fifth`, `eight` `eighth`,
   `nine` `ninth`, and `twelve` `twelfth`; a word ending in `y` ends in `ieth` instead (`twenty`,
   `twentieth`); any other word gets `th` (`fourth`, `eleventh`, `zeroth`, `hundredth`, `thousandth`,
   `millionth`). In a word with a hyphen, only the part after the hyphen changes: `forty-second`.

## from_words(text, style="us")

9. The number `to_words` writes as exactly `text` in that style. Any other text raises `ValueError`,
   however close it is: other spaces, capitals, a missing or extra hyphen or `and`, a misspelling, or a
   number out of range. A `text` that isn't a string raises `TypeError`, and a style as in rule 1.

## to_cheque(amount)

10. The amount in US-style words, as written on a cheque: the dollars in words, then `dollar` (for one)
    or `dollars`, then `and`, then the cents in words with `cent` (for one) or `cents`, or else `no
    cents`: `one thousand two hundred thirty-four dollars and fifty cents`, `one dollar and no cents`,
    `zero dollars and one cent`.
11. The amount is an `int` (of dollars), a `Decimal`, or a string of digits, optionally with a `.` and
    one or two more digits (`"1234.5"` is $1,234.50). It must be at least 0 and less than 10^15 dollars,
    with no fraction of a cent. A float raises `TypeError`, since it isn't exact, and so does any other
    type (`True` and `False` aren't numbers here); any other amount that can't be written raises
    `ValueError`.
'''

task(
    "number-words",
    "Implement to_words, to_ordinal, from_words and to_cheque in words.py so that they follow SPEC.md exactly.",
    ["python", "spec", "text"],
    {
        "SPEC.md": SPEC,
        "words.py": '''
            def to_words(n, style="us"):
                """n in US English words. See SPEC.md."""
                raise NotImplementedError


            def to_ordinal(n, style="us"):
                """n as an ordinal in words: first, forty-second. See SPEC.md."""
                raise NotImplementedError


            def from_words(text, style="us"):
                """The number to_words writes as text. See SPEC.md."""
                raise NotImplementedError


            def to_cheque(amount):
                """An amount of money in words, as on a cheque. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_words.py": '''
            import unittest

            from words import from_words, to_ordinal, to_words


            class TestBasics(unittest.TestCase):
                def test_words(self):
                    self.assertEqual(to_words(42), "forty-two")
                    self.assertEqual(to_words(305), "three hundred five")

                def test_ordinal(self):
                    self.assertEqual(to_ordinal(3), "third")

                def test_reading(self):
                    self.assertEqual(from_words("one hundred one"), 101)


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"words.py": open("words_solution.py").read()},
)
