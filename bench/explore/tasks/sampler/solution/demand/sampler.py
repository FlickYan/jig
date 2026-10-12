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
