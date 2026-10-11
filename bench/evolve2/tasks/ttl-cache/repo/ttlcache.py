import time


class Cache:
    """A cache with a size limit and a time to live. See SPEC.md."""

    def __init__(self, capacity, ttl, clock=time.monotonic):
        raise NotImplementedError
