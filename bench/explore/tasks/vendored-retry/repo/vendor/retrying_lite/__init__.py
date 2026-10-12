"""A small retry decorator, vendored from an internal library (version 0.3).

    @retrying(on=(TimeoutError,), attempts=3, delays=backoff(0.5), sleep=time.sleep, give_up=None)

on       exception types that are retried; anything else goes straight through
attempts how many calls in all, the first included
delays   an iterable of seconds to wait before each retry
sleep    the function that waits (tests pass a fake)
give_up  called with the last exception once the attempts are used up; what it returns is raised
"""
import functools
import itertools
import time


def backoff(first, factor=2):
    """first, first*factor, first*factor**2, ..."""
    return (first * factor**n for n in itertools.count())


def retrying(on, attempts, delays, sleep=time.sleep, give_up=None):
    def decorate(function):
        @functools.wraps(function)
        def wrapper(*args, **kwargs):
            waits = iter(delays() if callable(delays) else delays)
            for attempt in range(1, attempts + 1):
                try:
                    return function(*args, **kwargs)
                except on as err:
                    if attempt == attempts:
                        if give_up is None:
                            raise
                        raise give_up(err) from err
                    sleep(next(waits))
        return wrapper
    return decorate
