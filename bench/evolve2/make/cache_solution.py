"""A cache with a weight limit and a time to live. See SPEC.md."""
import time
from collections import OrderedDict


def _positive_int(value):
    return not isinstance(value, bool) and isinstance(value, int) and value >= 1


def _positive_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and value > 0


class Cache:
    def __init__(self, capacity, ttl, clock=time.monotonic):
        if not _positive_int(capacity):
            raise ValueError("capacity must be an int of at least 1")
        if not _positive_number(ttl):
            raise ValueError("ttl must be a number greater than 0")
        self._capacity = capacity
        self._ttl = ttl
        self._clock = clock
        self._entries = OrderedDict()  # key -> (value, expires, weight), least recently used first
        self._counts = {"hits": 0, "misses": 0, "evictions": 0, "expirations": 0}

    def _now(self):
        """The time, after dropping (and counting) the entries that have expired."""
        now = self._clock()
        for key in [key for key, (_, expires, _) in self._entries.items() if expires <= now]:
            del self._entries[key]
            self._counts["expirations"] += 1
        return now

    def put(self, key, value, weight=1, ttl=None):
        if not _positive_int(weight):
            raise ValueError("weight must be an int of at least 1")
        if ttl is not None and not _positive_number(ttl):
            raise ValueError("ttl must be a number greater than 0")
        if weight > self._capacity:
            raise ValueError(f"an entry of weight {weight} can't fit in {self._capacity}")
        now = self._now()
        self._entries.pop(key, None)
        while sum(w for _, _, w in self._entries.values()) + weight > self._capacity:
            self._entries.popitem(last=False)
            self._counts["evictions"] += 1
        self._entries[key] = (value, now + (self._ttl if ttl is None else ttl), weight)

    def get(self, key, default=None):
        self._now()
        if key not in self._entries:
            self._counts["misses"] += 1
            return default
        self._entries.move_to_end(key)
        self._counts["hits"] += 1
        return self._entries[key][0]

    def delete(self, key):
        self._now()
        return self._entries.pop(key, None) is not None

    @property
    def weight(self):
        self._now()
        return sum(w for _, _, w in self._entries.values())

    def __len__(self):
        self._now()
        return len(self._entries)

    def __contains__(self, key):
        self._now()
        return key in self._entries

    def stats(self):
        self._now()
        return dict(self._counts)
