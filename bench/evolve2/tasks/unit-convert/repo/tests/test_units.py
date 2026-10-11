import math
import unittest

from units import convert


class TestBasics(unittest.TestCase):
    def test_speed(self):
        self.assertTrue(math.isclose(convert(90, "km/h", "m/s"), 25.0))

    def test_incompatible(self):
        with self.assertRaises(ValueError):
            convert(1, "m", "s")


if __name__ == "__main__":
    unittest.main()
