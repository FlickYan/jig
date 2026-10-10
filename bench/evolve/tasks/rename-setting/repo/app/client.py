def fetch(url, settings, attempt):
    """Calls attempt(url) until it succeeds, retrying up to settings.max_retries times after the first try."""
    last = None
    for _ in range(settings.max_retries + 1):
        try:
            return attempt(url)
        except ConnectionError as error:
            last = error
    raise last
