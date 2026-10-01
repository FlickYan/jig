import unittest

from calc import average


class AverageTest(unittest.TestCase):
    def test_average(self):
        self.assertEqual(average([2, 4, 6]), 4)
