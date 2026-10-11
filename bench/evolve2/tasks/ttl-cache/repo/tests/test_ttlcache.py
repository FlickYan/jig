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
