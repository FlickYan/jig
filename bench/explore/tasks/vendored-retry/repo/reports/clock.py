import time


def sleep(seconds):
    """Every wait in the package goes through here, so tests can make it instant."""
    time.sleep(seconds)
