from maketask import task

hidden = '''
import time
import unittest

from ttlcache import Cache


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def stats(hits, misses, evictions, expirations):
    return {"hits": hits, "misses": misses, "evictions": evictions, "expirations": expirations}


class TestSpec(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()

    def cache(self, capacity, ttl=10):
        return Cache(capacity, ttl, clock=self.clock)

    def test_least_recently_used_is_evicted(self):
        cache = self.cache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        self.assertEqual(cache.get("a"), 1)
        cache.put("c", 3)
        self.assertIsNone(cache.get("b"))
        self.assertEqual((cache.get("a"), cache.get("c")), (1, 3))
        self.assertEqual(cache.stats(), stats(3, 1, 1, 0))

    def test_putting_a_live_key_replaces_it(self):
        cache = self.cache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.put("a", 10)
        self.assertEqual(len(cache), 2)
        cache.put("c", 3)
        self.assertEqual((cache.get("a"), cache.get("b"), cache.get("c")), (10, None, 3))
        self.assertEqual(cache.stats(), stats(2, 1, 1, 0))

    def test_an_entry_expires_ttl_seconds_after_it_was_stored(self):
        cache = self.cache(2)
        cache.put("a", 1)
        self.clock.now = 9.999
        self.assertEqual(cache.get("a"), 1)
        self.clock.now = 10
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.get("a", "gone"), "gone")
        self.assertEqual(cache.stats(), stats(1, 2, 0, 1))

    def test_getting_doesnt_extend_life_but_putting_does(self):
        cache = self.cache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        self.clock.now = 8
        cache.get("a")
        cache.put("b", 20)
        self.clock.now = 10
        self.assertNotIn("a", cache)
        self.assertEqual(cache.get("b"), 20)
        self.clock.now = 18
        self.assertEqual(len(cache), 0)
        self.assertEqual(cache.stats(), stats(2, 0, 0, 2))

    def test_expired_entries_take_no_room(self):
        cache = self.cache(2)
        cache.put("a", 1)
        self.clock.now = 5
        cache.put("b", 2)
        self.clock.now = 6
        cache.get("a")  # now b is the least recently used
        self.clock.now = 12
        cache.put("c", 3)  # a has expired: there is room, and b stays
        self.assertEqual((cache.get("b"), cache.get("c")), (2, 3))
        self.assertEqual(len(cache), 2)
        self.assertEqual(cache.stats(), stats(3, 0, 0, 1))

    def test_putting_an_expired_key_stores_a_new_entry(self):
        cache = self.cache(1)
        cache.put("a", 1)
        self.clock.now = 10
        cache.put("a", 2)
        self.assertEqual(cache.get("a"), 2)
        self.clock.now = 19.5
        self.assertIn("a", cache)
        self.assertEqual(cache.stats(), stats(1, 0, 0, 1))

    def test_delete(self):
        cache = self.cache(3)
        cache.put("a", 1)
        cache.put("b", 2)
        self.assertTrue(cache.delete("a"))
        self.assertFalse(cache.delete("a"))
        self.assertFalse(cache.delete("missing"))
        self.clock.now = 10
        self.assertFalse(cache.delete("b"))
        self.assertEqual(cache.stats(), stats(0, 0, 0, 1))

    def test_len_and_in_count_only_live_entries_and_change_nothing(self):
        cache = self.cache(2)
        cache.put("a", 1)
        self.clock.now = 4
        cache.put("b", 2)
        self.assertEqual(len(cache), 2)
        self.assertIn("a", cache)  # not a use: a is still the least recently used
        self.clock.now = 5
        cache.put("c", 3)
        self.assertNotIn("a", cache)
        self.clock.now = 14
        self.assertEqual(len(cache), 1)
        self.assertNotIn("b", cache)
        self.assertIn("c", cache)
        self.assertEqual(cache.stats(), stats(0, 0, 1, 1))

    def test_expirations_count_entries_nothing_looked_at(self):
        cache = self.cache(3)
        cache.put("a", 1)
        cache.put("b", 2)
        self.clock.now = 30
        self.assertEqual(cache.stats()["expirations"], 2)

    def test_replaced_deleted_and_evicted_entries_never_expire(self):
        cache = self.cache(1)
        cache.put("a", 1)
        self.clock.now = 5
        cache.put("a", 2)  # replaced: the first entry won't expire at 10
        self.clock.now = 12
        self.assertEqual(cache.stats()["expirations"], 0)
        cache.put("b", 3)  # evicts a, which would have expired at 15
        self.assertTrue(cache.delete("b"))  # b would have expired at 22
        self.clock.now = 40
        self.assertEqual(cache.stats(), stats(0, 0, 1, 0))

    def test_a_longer_run(self):
        cache = self.cache(3, ttl=5)
        # Second by second: a hit at 2 and 6; b evicted at 4 and d at 7; a expired at 5 and c at 8.
        for second, key in enumerate("abacdacec"):
            self.clock.now = second
            if cache.get(key) is None:
                cache.put(key, second)
        self.assertEqual(sorted(key for key in "abcde" if key in cache), ["a", "c", "e"])
        self.assertEqual(cache.stats(), stats(2, 7, 2, 2))

    def test_weights_fill_the_capacity(self):
        cache = self.cache(10)
        for key in "abc":
            cache.put(key, key.upper(), weight=4)
        self.assertEqual((cache.weight, len(cache)), (8, 2))
        self.assertNotIn("a", cache)
        self.assertEqual(cache.stats(), stats(0, 0, 1, 0))

    def test_a_heavy_entry_evicts_as_many_as_it_needs(self):
        cache = self.cache(10)
        for key in "abc":
            cache.put(key, 1, weight=3)
        cache.get("a")  # b is now the least recently used, then c, then a
        cache.put("d", 1, weight=8)
        self.assertEqual(sorted(key for key in "abcd" if key in cache), ["d"])
        self.assertEqual(cache.stats()["evictions"], 3)
        cache.put("e", 1, weight=2)
        self.assertEqual((cache.weight, cache.stats()["evictions"]), (10, 3))

    def test_eviction_stops_once_it_fits(self):
        cache = self.cache(10)
        cache.put("a", 1, weight=5)
        cache.put("b", 1, weight=2)
        cache.put("c", 1, weight=2)
        cache.put("d", 1, weight=4)  # 9 + 4: a goes, and 4 + 4 fits
        self.assertEqual(sorted(key for key in "abcd" if key in cache), ["b", "c", "d"])
        self.assertEqual(cache.weight, 8)

    def test_a_replaced_entry_doesnt_count(self):
        cache = self.cache(10)
        cache.put("a", 1, weight=4)
        cache.put("b", 1, weight=4)
        cache.put("a", 2, weight=6)  # b + the new a is exactly 10
        self.assertEqual((cache.get("a"), cache.get("b"), cache.weight), (2, 1, 10))
        cache.put("a", 3, weight=8)  # now b has to go
        self.assertEqual((cache.get("a"), cache.get("b"), cache.weight), (3, None, 8))
        self.assertEqual(cache.stats(), stats(3, 1, 1, 0))

    def test_too_heavy_changes_nothing(self):
        cache = self.cache(10)
        cache.put("a", 1, weight=6)
        with self.assertRaises(ValueError):
            cache.put("b", 1, weight=11)
        with self.assertRaises(ValueError):
            cache.put("a", 2, weight=11)
        self.assertEqual((cache.get("a"), cache.weight), (1, 6))
        self.assertEqual(cache.stats(), stats(1, 0, 0, 0))

    def test_expired_entries_weigh_nothing(self):
        cache = self.cache(10)
        cache.put("a", 1, weight=6)
        self.clock.now = 11
        self.assertEqual(cache.weight, 0)
        cache.put("b", 1, weight=6)
        self.assertEqual(cache.stats(), stats(0, 0, 0, 1))

    def test_an_entry_may_have_its_own_time_to_live(self):
        cache = self.cache(3)
        cache.put("short", 1, ttl=2)
        cache.put("long", 1, ttl=30)
        cache.put("default", 1)
        self.clock.now = 2
        self.assertEqual(sorted(key for key in ("short", "long", "default") if key in cache), ["default", "long"])
        self.clock.now = 10
        self.assertEqual(sorted(key for key in ("short", "long", "default") if key in cache), ["long"])
        cache.put("long", 2)  # replaced: now with the cache's ttl, from 10
        self.clock.now = 20
        self.assertNotIn("long", cache)
        self.assertEqual(cache.stats()["expirations"], 3)

    def test_invalid_entries(self):
        cache = self.cache(10)
        for weight in (0, -1, 1.5, True, "2"):
            with self.subTest(weight=weight):
                with self.assertRaises(ValueError):
                    cache.put("a", 1, weight=weight)
        for ttl in (0, -1, "5", True):
            with self.subTest(ttl=ttl):
                with self.assertRaises(ValueError):
                    cache.put("a", 1, ttl=ttl)
        self.assertEqual(len(cache), 0)

    def test_invalid_settings(self):
        for capacity, ttl in ((0, 10), (-1, 10), (1.5, 10), (True, 10), (2, 0), (2, -1), (2, "10")):
            with self.subTest(capacity=capacity, ttl=ttl):
                with self.assertRaises(ValueError):
                    Cache(capacity, ttl, clock=self.clock)

    def test_the_real_clock(self):
        cache = Cache(2, 60)
        cache.put("a", 1)
        self.assertEqual(cache.get("a"), 1)


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
# Cache(capacity, ttl, clock=time.monotonic)

A cache whose live entries weigh at most `capacity` together, each living `ttl` seconds from when it was
stored (or its own time to live), and that makes room by evicting the least recently used. `clock()`
gives the time in seconds (the tests pass a fake one).

1. `capacity` is an `int` of at least 1, and `ttl` a number greater than 0 (neither may be a `bool`);
   anything else raises `ValueError`.
2. An entry stored at time t with a time to live of d is live while the clock reads less than t + d, and
   expired from t + d on. An expired entry is as good as gone: nothing returns it, counts it as live,
   weighs it, or evicts it.
3. `put(key, value, weight=1, ttl=None)` stores the value under the key, live from now, as the most
   recently used entry, with that weight (an `int` of at least 1) and time to live (a number greater
   than 0, or the cache's `ttl` if it is `None`). An invalid weight or time to live, or a weight greater
   than `capacity`, raises `ValueError` and changes nothing. If the key has a live entry, that entry is
   replaced, and weighs nothing toward room for the new one. Then, while the live entries and the new one
   would weigh more than `capacity`, the least recently used live entry is evicted.
4. `get(key, default=None)` returns the value of the key's live entry, which becomes the most recently
   used (it still expires when it would have): a hit. If the key has no live entry, it returns `default`:
   a miss.
5. `delete(key)` removes the key's live entry and returns `True`, or returns `False` if it has none.
6. `len(cache)` is the number of live entries, `cache.weight` what they weigh together, and `key in
   cache` says whether the key has a live entry. None of them is a hit or a miss, and none changes which
   entry was used most recently.
7. `stats()` returns a dict of four counts since the cache was made: `"hits"` and `"misses"` (of `get`),
   `"evictions"` (the entries evicted by rule 3), and `"expirations"`: the entries that have expired,
   that is, that reached the end of their life (rule 2) before anything replaced, deleted or evicted them,
   whether or not anything has looked at them since.
'''

task(
    "ttl-cache",
    "Implement the Cache class in ttlcache.py so that it follows SPEC.md exactly.",
    ["python", "spec", "state"],
    {
        "SPEC.md": SPEC,
        "ttlcache.py": '''
            import time


            class Cache:
                """A cache with a size limit and a time to live. See SPEC.md."""

                def __init__(self, capacity, ttl, clock=time.monotonic):
                    raise NotImplementedError
        ''',
        "tests/test_ttlcache.py": '''
            import unittest

            from ttlcache import Cache


            class TestBasics(unittest.TestCase):
                def test_put_and_get(self):
                    now = [0]
                    cache = Cache(2, 10, clock=lambda: now[0])
                    cache.put("a", 1)
                    self.assertEqual(cache.get("a"), 1)
                    self.assertIsNone(cache.get("b"))

                def test_expiry(self):
                    now = [0]
                    cache = Cache(2, 10, clock=lambda: now[0])
                    cache.put("a", 1)
                    now[0] = 11
                    self.assertIsNone(cache.get("a"))


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"ttlcache.py": open("cache_solution.py").read()},
)
