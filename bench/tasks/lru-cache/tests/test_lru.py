import time
import unittest

from lru import LRUCache


class LRUTest(unittest.TestCase):
    def test_get_and_put(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        self.assertEqual(cache.get("a"), 1)
        self.assertIsNone(cache.get("missing"))
        self.assertEqual(cache.get("missing", 0), 0)

    def test_evicts_the_least_recently_used(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.get("a")  # now b is the least recently used
        cache.put("c", 3)
        self.assertNotIn("b", cache)
        self.assertEqual((cache.get("a"), cache.get("c")), (1, 3))
        self.assertEqual(len(cache), 2)

    def test_updating_a_key_does_not_evict(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.put("a", 10)
        self.assertEqual(len(cache), 2)
        cache.put("c", 3)  # b is the least recently used now
        self.assertEqual((cache.get("a"), cache.get("b")), (10, None))

    def test_in_does_not_change_recency(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        self.assertIn("a", cache)
        cache.put("c", 3)
        self.assertNotIn("a", cache)

    def test_stats(self):
        cache = LRUCache(1)
        cache.get("x")
        cache.put("x", 1)
        cache.get("x")
        cache.put("y", 2)
        self.assertEqual(cache.stats(), {"hits": 1, "misses": 1, "evictions": 1})

    def test_capacity_must_be_positive(self):
        for capacity in (0, -1, 2.5, "3"):
            with self.assertRaises(ValueError):
                LRUCache(capacity)

    def test_constant_time(self):
        cache = LRUCache(50_000)
        started = time.perf_counter()
        for i in range(200_000):
            cache.put(i, i)
            cache.get(i // 2)
        self.assertLess(time.perf_counter() - started, 3.0)


if __name__ == "__main__":
    unittest.main()
