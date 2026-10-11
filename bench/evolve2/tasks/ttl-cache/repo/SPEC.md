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
