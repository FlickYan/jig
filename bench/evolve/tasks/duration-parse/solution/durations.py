import math
import re

UNITS = {
    "d": 86400, "day": 86400, "days": 86400,
    "h": 3600, "hour": 3600, "hours": 3600,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
}
PART = re.compile(r"(\d+(?:\.\d+)?)\s*([a-z]+)")


def parse_duration(text):
    """The number of seconds in a duration like '1h30m'. See SPEC.md."""
    def fail():
        raise ValueError(f"not a duration: {text!r}")

    if not isinstance(text, str):
        fail()
    body = text.strip().lower()
    if not body:
        fail()
    if re.fullmatch(r"\d+(?:\.\d+)?", body):
        return math.floor(float(body) + 0.5)
    total = 0.0
    seen = set()
    position = 0
    while position < len(body):
        match = PART.match(body, position)
        if not match or match.group(2) not in UNITS:
            fail()
        seconds = UNITS[match.group(2)]
        if seconds in seen:
            fail()
        seen.add(seconds)
        total += float(match.group(1)) * seconds
        position = match.end()
        separator = re.match(r"\s*(?:,|\band\b)?\s*", body[position:])
        position += separator.end()
        if position < len(body) and separator.group(0).strip() and not PART.match(body, position):
            fail()
    if re.search(r"(,|\band)\s*$", body):
        fail()
    return math.floor(total + 0.5)
