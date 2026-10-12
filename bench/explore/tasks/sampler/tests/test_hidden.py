import math
import random
import statistics
import time
import unittest

from demand.sampler import draw


def cdf(a, lo=-4.5, hi=4.5, steps=90000):
    """The distribution function, by the trapezoid rule on a fine grid: (lo, step, cumulative values)."""
    h = (hi - lo) / steps
    values = [math.exp(-(lo + i * h) ** 4 + a * (lo + i * h) ** 2) for i in range(steps + 1)]
    total, cumulative = 0.0, [0.0]
    for i in range(steps):
        total += (values[i] + values[i + 1]) * h / 2
        cumulative.append(total)
    return lo, h, [c / total for c in cumulative]


def ks_distance(samples, a):
    lo, h, cumulative = cdf(a)
    ordered, n, worst = sorted(samples), len(samples), 0.0
    for i, x in enumerate(ordered):
        k = min(max(int((x - lo) / h), 0), len(cumulative) - 2)
        t = min(max((x - lo) / h - k, 0.0), 1.0)
        F = cumulative[k] + t * (cumulative[k + 1] - cumulative[k])
        worst = max(worst, abs(F - i / n), abs(F - (i + 1) / n))
    return worst


class DistributionTest(unittest.TestCase):
    def test_follows_the_distribution_for_every_a(self):
        # With 40,000 samples a correct sampler's distance is about 0.004; 0.015 almost never happens.
        for a in (-5, -2, 0, 1, 3, 5):
            with self.subTest(a=a):
                samples = draw(40000, a, random.Random(100 + a))
                self.assertEqual(len(samples), 40000)
                self.assertLess(ks_distance(samples, a), 0.015)

    def test_both_peaks_get_their_share(self):
        samples = draw(40000, 4, random.Random(3))
        self.assertAlmostEqual(sum(x > 0 for x in samples) / len(samples), 0.5, delta=0.02)
        self.assertAlmostEqual(statistics.fmean(abs(x) for x in samples), 1.32, delta=0.03)  # 1.3192

    def test_only_rng_is_random(self):
        self.assertEqual(draw(50, 3, random.Random(9)), draw(50, 3, random.Random(9)))
        self.assertNotEqual(draw(50, 3, random.Random(9)), draw(50, 3, random.Random(10)))

    def test_fast_enough(self):
        for a in (-5, 5):
            started = time.perf_counter()
            draw(100000, a, random.Random(1))
            self.assertLess(time.perf_counter() - started, 3, f"a = {a}")
