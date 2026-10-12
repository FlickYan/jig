"""sampler: the visible test checks one value of the parameter; the spec asks for all of them.

What the agent must do beyond its first check: SPEC.md asks for samples from exp(-x^4 + a*x^2) for every a
from -5 to 5, and the project's own test only tries a = 0, where a sampler tuned by eye passes. For a > 0
the density has two peaks, away from 0; a proposal or bound fitted at a = 0 no longer covers them, and the
samples come out wrong. The hidden tests compare samples with the distribution (Kolmogorov-Smirnov) for
six values of a, and check speed and reproducibility.
"""
from maketask import task

FILES = {
    "README.md": """
        # demand

        A simulation of the shop's weekly demand. The random part is specified in SPEC.md.
        """,
    "SPEC.md": """
        # draw(n, a, rng)

        Returns a list of `n` independent samples from the distribution on the real line whose density is
        proportional to

            exp(-x**4 + a * x**2)

        for any real `a`. The demand model uses values of `a` from -5 to 5: below 0 the samples crowd
        around 0, and above it they split between a peak on each side.

        - Use only `rng`, a `random.Random`, for randomness, so that the same seed gives the same samples.
        - The samples must follow the distribution; the tests compare them with it.
        - 100,000 samples must take less than 2 seconds, for any `a` from -5 to 5.
        """,
    "demand/__init__.py": "",
    "demand/sampler.py": '''
        def draw(n, a, rng):
            """n samples from the density proportional to exp(-x**4 + a*x**2). See SPEC.md."""
            raise NotImplementedError
        ''',
    "demand/weekly.py": '''
        import random

        from demand.sampler import draw


        def weekly_demand(base, weeks, a, seed=0):
            """Simulated demand for each week: the base, moved up or down by the model's noise."""
            noise = draw(weeks, a, random.Random(seed))
            return [max(0, round(base * (1 + 0.1 * x))) for x in noise]
        ''',
    "tests/__init__.py": "",
    "tests/test_sampler.py": """
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
        """,
}

SOLUTION = {
    "demand/sampler.py": '''
        import math


        def draw(n, a, rng):
            """n samples from the density proportional to exp(-x**4 + a*x**2). See SPEC.md.

            |x| is sqrt(u), where u has a density proportional to u**-0.5 * exp(-u*u + a*u) on u > 0. That is
            sampled by rejection from Gamma(1/2, theta), whose density is proportional to u**-0.5 * exp(-u/theta):
            the ratio is exp(-u*u + b*u) with b = a + 1/theta, which is at most exp((b/2)**2) when b > 0 (else
            at most 1), so every u is accepted with the exact probability it should be. theta is chosen so that
            the ratio peaks where the target does, which keeps the acceptance rate up for every a.
            """
            theta = 1 / max(1e-9, (math.sqrt(a * a + 8) - a) / 2)
            b = a + 1 / theta
            top = (b / 2) ** 2 if b > 0 else 0.0
            samples = []
            while len(samples) < n:
                u = rng.gammavariate(0.5, theta)
                if rng.random() < math.exp(-u * u + b * u - top):
                    x = math.sqrt(u)
                    samples.append(x if rng.random() < 0.5 else -x)
            return samples
        ''',
}

HIDDEN = '''
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
'''

task(
    "sampler",
    "Implement draw in demand/sampler.py so that it follows SPEC.md.",
    ["python", "spec", "statistics", "generalization"],
    FILES,
    HIDDEN,
    SOLUTION,
)
