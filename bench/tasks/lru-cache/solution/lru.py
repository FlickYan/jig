"""Caching for the recommendations service."""
from collections import OrderedDict


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
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise ValueError("capacity must be a positive int")
        self.capacity = capacity
        self._entries = OrderedDict()
        self._stats = {"hits": 0, "misses": 0, "evictions": 0}

    def get(self, key, default=None):
        if key not in self._entries:
            self._stats["misses"] += 1
            return default
        self._stats["hits"] += 1
        self._entries.move_to_end(key)
        return self._entries[key]

    def put(self, key, value):
        self._entries[key] = value
        self._entries.move_to_end(key)
        if len(self._entries) > self.capacity:
            self._entries.popitem(last=False)
            self._stats["evictions"] += 1

    def __len__(self):
        return len(self._entries)

    def __contains__(self, key):
        return key in self._entries

    def stats(self):
        return dict(self._stats)
