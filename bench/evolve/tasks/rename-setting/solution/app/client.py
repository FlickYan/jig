def fetch(url, settings, attempt):
    """Calls attempt(url) until it succeeds, retrying up to settings.retry_limit times after the first try."""
    last = None
    for _ in range(settings.retry_limit + 1):
        try:
            return attempt(url)
        except ConnectionError as error:
            last = error
    raise last
