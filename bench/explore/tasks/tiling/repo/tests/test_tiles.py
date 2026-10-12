import unittest

from floors.tiles import count_tilings


class TilesTest(unittest.TestCase):
    def test_a_strip_two_wide(self):
        self.assertEqual([count_tilings(2, n) for n in range(1, 5)], [2, 7, 22, 71])

    def test_a_small_room(self):
        self.assertEqual(count_tilings(3, 2), 22)
