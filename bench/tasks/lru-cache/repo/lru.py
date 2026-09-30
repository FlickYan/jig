"""Caching for the recommendations service."""


class LRUCache:
    """A cache holding at most `capacity` entries that evicts the least recently used one.

    - LRUCache(capacity): capacity must be a positive int, otherwise raise ValueError.
    - get(key, default=None): the value for key, marking it as most recently used; `default` if missing.
    - put(key, value): insert or update key, marking it as most recently used. When that makes the cache
      exceed its capacity, evict the least recently used entry.
    - len(cache) is the number of entries, and `key in cache` checks for a key without changing recency.
    - stats() returns {"hits": ..., "misses": ..., "evictions": ...}: hits and misses count get() calls.

    get and put must take O(1) time.
    """

    def __init__(self, capacity):
        raise NotImplementedError
