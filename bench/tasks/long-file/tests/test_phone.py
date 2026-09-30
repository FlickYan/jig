import unittest

from utils.helpers import chunk_2, clamp_6, normalize_phone, slug_1


class PhoneTest(unittest.TestCase):
    def test_international_numbers_keep_the_plus(self):
        self.assertEqual(normalize_phone("+44 20 7946 0958"), "+442079460958")
        self.assertEqual(normalize_phone("  +1 (555) 123-4567 "), "+15551234567")
        self.assertEqual(normalize_phone("+81-3-1234-5678"), "+81312345678")

    def test_us_numbers(self):
        self.assertEqual(normalize_phone("(555) 123-4567"), "+15551234567")
        self.assertEqual(normalize_phone("1-555-123-4567"), "+15551234567")

    def test_the_rest_of_the_module_still_works(self):
        self.assertEqual(slug_1("Hello, World!"), "hello-world")
        self.assertEqual(chunk_2([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
        self.assertEqual(clamp_6(1000, 0, 10), 10)


if __name__ == "__main__":
    unittest.main()
