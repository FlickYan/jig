import random
import statistics
import unittest

from demand.sampler import draw


class SamplerTest(unittest.TestCase):
    def test_centred_and_spread_as_expected(self):
        samples = draw(20000, 0, random.Random(1))
        self.assertEqual(len(samples), 20000)
        self.assertAlmostEqual(statistics.fmean(samples), 0, delta=0.03)
        self.assertAlmostEqual(statistics.pvariance(samples), 0.338, delta=0.03)

    def test_a_seed_gives_the_same_samples(self):
        self.assertEqual(draw(10, 0, random.Random(7)), draw(10, 0, random.Random(7)))
