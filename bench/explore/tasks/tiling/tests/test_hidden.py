import time
import unittest

from floors.tiles import count_tilings

SMALL = {'1x0': 1, '1x1': 1, '1x2': 2, '1x3': 3, '1x4': 5, '1x5': 8, '2x0': 1, '2x1': 2, '2x2': 7, '2x3': 22, '2x4': 71, '2x5': 228, '3x0': 1, '3x1': 3, '3x2': 22, '3x3': 131, '3x4': 823, '3x5': 5096, '4x0': 1, '4x1': 5, '4x2': 71, '4x3': 823, '4x4': 10012, '4x5': 120465}
LARGE = {'1x1000000000': 999999994, '1x123456789': 403555901, '1x1000': 107579939, '2x1000000000': 910094545, '2x123456789': 997342785, '2x1000': 237447039, '3x1000000000': 817133891, '3x123456789': 52481040, '3x1000': 965774094, '4x1000000000': 211483083, '4x123456789': 508140473, '4x1000': 137343275, '5x1000000000': 608828562, '5x123456789': 891003279, '5x1000': 195137131}


class TilingTest(unittest.TestCase):
    def test_small_floors_against_counting_every_tiling(self):
        for key, expected in SMALL.items():
            width, length = map(int, key.split("x"))
            self.assertEqual(count_tilings(width, length), expected, key)

    def test_long_floors(self):
        for key, expected in LARGE.items():
            width, length = map(int, key.split("x"))
            started = time.perf_counter()
            self.assertEqual(count_tilings(width, length), expected, key)
            self.assertLess(time.perf_counter() - started, 2, key)
