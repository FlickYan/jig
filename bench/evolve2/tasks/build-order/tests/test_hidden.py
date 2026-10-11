import heapq
import random
import signal
import unittest

from buildorder import CycleError, build_order


class Limit:
    """Fails the test if the block takes longer than the seconds given (it interrupts a long loop)."""

    def __init__(self, seconds):
        self.seconds = seconds

    def fail(self, *_):
        raise TimeoutError(f"took more than {self.seconds} seconds")

    def __enter__(self):
        signal.signal(signal.SIGALRM, self.fail)
        signal.alarm(self.seconds)

    def __exit__(self, *exc):
        signal.alarm(0)


def expected_order(targets):
    """The order rule 2 fixes, worked out independently."""
    waiting = {t: len(set(d)) for t, d in targets.items()}
    dependents = {t: [] for t in targets}
    for t, deps in targets.items():
        for d in set(deps):
            dependents[d].append(t)
    ready = sorted(t for t, n in waiting.items() if n == 0)
    heapq.heapify(ready)
    order = []
    while ready:
        t = heapq.heappop(ready)
        order.append(t)
        for u in dependents[t]:
            waiting[u] -= 1
            if waiting[u] == 0:
                heapq.heappush(ready, u)
    return order


def chain(n):
    return {f"t{i:06d}": ([f"t{i - 1:06d}"] if i else []) for i in range(n)}


def wide(n, seed):
    rng = random.Random(seed)
    names = [f"n{i:06d}" for i in range(n)]
    rng.shuffle(names)
    return {name: [names[j] for j in {rng.randrange(i) for _ in range(min(i, 3))}] if i else [] for i, name in enumerate(names)}


class TestSpec(unittest.TestCase):
    def assert_cycle(self, targets, cycle):
        self.assertIsInstance(cycle, list)
        self.assertTrue(cycle, "the cycle is empty")
        self.assertEqual(len(set(cycle)), len(cycle), "a target appears twice in the cycle")
        for here, there in zip(cycle, cycle[1:] + cycle[:1]):
            self.assertIn(there, targets[here], f"{here} doesn't depend on {there}")

    def test_small_orders(self):
        cases = [
            ({"app": ["lib", "util"], "lib": ["util"], "util": [], "docs": []}, ["docs", "util", "lib", "app"]),
            ({}, []),
            ({"b": [], "a": [], "c": []}, ["a", "b", "c"]),
            ({"z": [], "y": ["z"], "a": ["y"]}, ["z", "y", "a"]),
            ({"t9": [], "t10": [], "t1": ["t9"]}, ["t10", "t9", "t1"]),
            ({"d": ["b", "c"], "b": ["a"], "c": ["a"], "a": [], "e": []}, ["a", "b", "c", "d", "e"]),
            ({"x": ["m"], "m": [], "b": ["x"], "c": []}, ["c", "m", "x", "b"]),
        ]
        for targets, expected in cases:
            with self.subTest(targets=targets):
                self.assertEqual(build_order(targets), expected)

    def test_repeated_dependencies(self):
        self.assertEqual(build_order({"a": ["b", "b", "c", "b"], "b": ["c"], "c": []}), ["c", "b", "a"])

    def test_unknown_dependency(self):
        with self.assertRaises(ValueError):
            build_order({"a": ["b"]})

    def test_cycles(self):
        cases = [
            {"a": ["b"], "b": ["c"], "c": ["a"], "d": ["a"]},
            {"a": ["a"]},
            {"a": ["b"], "b": ["a", "c"], "c": [], "d": ["c"], "e": ["d", "b"]},
            {"p": ["q", "r"], "q": ["r"], "r": ["s"], "s": ["q"], "z": []},
        ]
        for targets in cases:
            with self.subTest(targets=targets):
                with self.assertRaises(CycleError) as caught:
                    build_order(targets)
                self.assert_cycle(targets, caught.exception.cycle)
        self.assertTrue(issubclass(CycleError, ValueError))

    def test_a_long_chain(self):
        targets = chain(200_000)
        with Limit(10):
            order = build_order(targets)
        self.assertEqual(order, [f"t{i:06d}" for i in range(200_000)])

    def test_a_wide_graph(self):
        targets = wide(200_000, seed=1)
        with Limit(10):
            order = build_order(targets)
        self.assertEqual(order, expected_order(targets))

    def test_a_long_cycle(self):
        targets = chain(200_000)
        targets["t000000"] = ["t199999"]
        with Limit(10):
            with self.assertRaises(CycleError) as caught:
                build_order(targets)
        self.assert_cycle(targets, caught.exception.cycle)

    def test_a_cycle_deep_in_a_wide_graph(self):
        targets = wide(100_000, seed=2)
        names = sorted(targets)
        targets[names[0]] = targets[names[0]] + [names[-1]]
        targets[names[-1]] = targets[names[-1]] + [names[0]]
        with Limit(10):
            with self.assertRaises(CycleError) as caught:
                build_order(targets)
        self.assert_cycle(targets, caught.exception.cycle)


if __name__ == "__main__":
    unittest.main()
