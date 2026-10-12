import random

from demand.sampler import draw


def weekly_demand(base, weeks, a, seed=0):
    """Simulated demand for each week: the base, moved up or down by the model's noise."""
    noise = draw(weeks, a, random.Random(seed))
    return [max(0, round(base * (1 + 0.1 * x))) for x in noise]
