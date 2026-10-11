"""The dates a recurrence rule produces. See SPEC.md."""
import calendar
import re
from datetime import date, timedelta

DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
PARTS = {"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYMONTH", "BYMONTHDAY", "BYDAY", "BYSETPOS"}


def occurrences(rule, start, limit=100):
    r = _parse(rule)
    count = r["COUNT"] or limit
    out = []
    for period in _periods(r, start):
        days = _candidates(r, start, period)
        if r["BYSETPOS"]:
            picked = set()
            for position in r["BYSETPOS"]:
                index = position - 1 if position > 0 else len(days) + position
                if 0 <= index < len(days):
                    picked.add(days[index])
            days = sorted(picked)
        for day in days:
            if day < start:
                continue
            if r["UNTIL"] and day > r["UNTIL"]:
                return out
            out.append(day)
            if len(out) == count:
                return out
    return out


def _integers(value, low, high, name):
    """Comma-separated integers whose size is from low to high, either sign."""
    items = []
    for text in value.split(","):
        if not re.fullmatch(r"[+-]?\d+", text):
            raise ValueError(f"{name}: {text!r} isn't a number")
        number = int(text)
        if not low <= abs(number) <= high:
            raise ValueError(f"{name}: {number} is out of range")
        items.append(number)
    return items


def _parse(rule):
    r = {"FREQ": None, "INTERVAL": 1, "COUNT": None, "UNTIL": None, "BYMONTH": [], "BYMONTHDAY": [], "BYDAY": [], "BYSETPOS": []}
    seen = set()
    for part in rule.split(";"):
        name, sep, value = part.partition("=")
        if not sep or not value or name not in PARTS or name in seen:
            raise ValueError(f"invalid part {part!r}")
        seen.add(name)
        if name == "FREQ":
            if value not in FREQS:
                raise ValueError(f"unknown FREQ {value}")
            r["FREQ"] = value
        elif name in ("INTERVAL", "COUNT"):
            if not re.fullmatch(r"\d+", value) or int(value) < 1:
                raise ValueError(f"{name} must be a positive integer")
            r[name] = int(value)
        elif name == "UNTIL":
            if not re.fullmatch(r"\d{8}", value):
                raise ValueError("UNTIL must be YYYYMMDD")
            r["UNTIL"] = date(int(value[:4]), int(value[4:6]), int(value[6:]))
        elif name == "BYMONTH":
            months = _integers(value, 1, 12, name)
            if any(m < 1 for m in months):
                raise ValueError("BYMONTH is 1 to 12")
            r["BYMONTH"] = months
        elif name == "BYMONTHDAY":
            r["BYMONTHDAY"] = _integers(value, 1, 31, name)
        elif name == "BYSETPOS":
            r["BYSETPOS"] = _integers(value, 1, 366, name)
        elif name == "BYDAY":
            for text in value.split(","):
                match = re.fullmatch(r"([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)", text)
                if not match:
                    raise ValueError(f"BYDAY: {text!r}")
                ordinal = int(match.group(1)) if match.group(1) else None
                if ordinal is not None and not (1 <= abs(ordinal) <= 53):
                    raise ValueError(f"BYDAY: {text!r}")
                r["BYDAY"].append((ordinal, DAYS.index(match.group(2))))
    if r["FREQ"] is None:
        raise ValueError("FREQ is required")
    if r["COUNT"] and r["UNTIL"]:
        raise ValueError("COUNT and UNTIL can't be used together")
    if r["FREQ"] in ("DAILY", "WEEKLY") and any(ordinal is not None for ordinal, _ in r["BYDAY"]):
        raise ValueError("BYDAY ordinals need FREQ=MONTHLY or YEARLY")
    if r["FREQ"] == "WEEKLY" and r["BYMONTHDAY"]:
        raise ValueError("BYMONTHDAY can't be used with FREQ=WEEKLY")
    if r["BYSETPOS"] and r["FREQ"] not in ("MONTHLY", "YEARLY"):
        raise ValueError("BYSETPOS needs FREQ=MONTHLY or YEARLY")
    return r


def _periods(r, start):
    """The first day and the days of each period the rule applies to, from the one containing start."""
    step = r["INTERVAL"]
    if r["FREQ"] == "DAILY":
        day = start
        while True:
            yield [day]
            if (date.max - day).days < step:
                return
            day += timedelta(days=step)
    elif r["FREQ"] == "WEEKLY":
        monday = start - timedelta(days=start.weekday())
        while (date.max - monday).days >= 7:
            yield [monday + timedelta(days=i) for i in range(7)]
            if (date.max - monday).days < 7 * step + 7:
                return
            monday += timedelta(days=7 * step)
    elif r["FREQ"] == "MONTHLY":
        year, month = start.year, start.month
        while year <= 9999:
            yield [date(year, month, d) for d in range(1, calendar.monthrange(year, month)[1] + 1)]
            month += step
            year, month = year + (month - 1) // 12, (month - 1) % 12 + 1
    else:
        year = start.year
        while year <= 9999:
            first = date(year, 1, 1)
            yield [first + timedelta(days=i) for i in range(366 if calendar.isleap(year) else 365)]
            year += step


def _candidates(r, start, days):
    freq = r["FREQ"]
    out = []
    for day in days:
        month_length = calendar.monthrange(day.year, day.month)[1]
        if r["BYMONTH"] and day.month not in r["BYMONTH"]:
            continue
        if r["BYMONTHDAY"] and not any(md == day.day or (md < 0 and month_length + md + 1 == day.day) for md in r["BYMONTHDAY"]):
            continue
        if r["BYDAY"] and not any(weekday == day.weekday() and (ordinal is None or _nth(day, ordinal, freq == "YEARLY" and not r["BYMONTH"])) for ordinal, weekday in r["BYDAY"]):
            continue
        if freq == "WEEKLY" and not r["BYDAY"] and day.weekday() != start.weekday():
            continue
        if freq in ("MONTHLY", "YEARLY") and not r["BYMONTHDAY"] and not r["BYDAY"]:
            if day.day != start.day or (freq == "YEARLY" and not r["BYMONTH"] and day.month != start.month):
                continue
        out.append(day)
    return out


def _nth(day, ordinal, in_year):
    """Whether day is the ordinal-th of its weekday in its year (in_year) or its month."""
    if in_year:
        index = day.timetuple().tm_yday
        length = 366 if calendar.isleap(day.year) else 365
    else:
        index = day.day
        length = calendar.monthrange(day.year, day.month)[1]
    return ordinal == (index - 1) // 7 + 1 or ordinal == -((length - index) // 7 + 1)
