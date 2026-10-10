import unittest

from roman import from_roman, to_roman


class TestSpec(unittest.TestCase):
    def test_round_trip(self):
        for n in range(1, 4000):
            self.assertEqual(from_roman(to_roman(n)), n)

    def test_known(self):
        self.assertEqual(to_roman(3999), "MMMCMXCIX")
        self.assertEqual(to_roman(40), "XL")
        self.assertEqual(to_roman(444), "CDXLIV")

    def test_range_and_types(self):
        for bad in [0, -1, 4000, 10000, True, 2.0, "12", None]:
            with self.assertRaises(ValueError, msg=repr(bad)):
                to_roman(bad)

    def test_case_and_whitespace(self):
        self.assertEqual(from_roman("mcmxciv"), 1994)
        self.assertEqual(from_roman("  XiV \n"), 14)

    def test_only_standard_form(self):
        for bad in ["IIII", "VV", "IC", "IL", "XM", "IIV", "VX", "XCX", "IXIX", "MMMM", "", "  ", "IIIII", "LL", "DD", "CMC", "XIIII", "ABC", "X I"]:
            with self.assertRaises(ValueError, msg=bad):
                from_roman(bad)

    def test_message(self):
        with self.assertRaises(ValueError) as caught:
            from_roman("IIII")
        self.assertIn("IIII", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
