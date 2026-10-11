"""Business days, with holidays given as rules. See SPEC.md."""
import calendar
import re
from datetime import date, timedelta

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
ORDINALS = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "last": -1}
WEEKDAY_RULE = re.compile(rf"({'|'.join(ORDINALS)}) ({'|'.join(WEEKDAYS)}) of ({'|'.join(MONTHS)})")


def _parse(rules):
    parsed = []
    for rule in rules:
        if isinstance(rule, str) and re.fullmatch(r"\d\d-\d\d", rule):
            month, day = int(rule[:2]), int(rule[3:])
            if not (1 <= month <= 12 and 1 <= day <= calendar.monthrange(2000, month)[1]):
                raise ValueError(f"not a date: {rule!r}")
            parsed.append(("fixed", month, day))
            continue
        match = WEEKDAY_RULE.fullmatch(rule) if isinstance(rule, str) else None
        if not match:
            raise ValueError(f"not a holiday rule: {rule!r}")
        parsed.append(("weekday", ORDINALS[match.group(1)], WEEKDAYS.index(match.group(2)), MONTHS.index(match.group(3)) + 1))
    return parsed


def _observed(year, parsed):
    """The observed dates of the holidays of a year, wherever they fall."""
    days = set()
    for rule in parsed:
        if rule[0] == "fixed":
            _, month, day = rule
            if day > calendar.monthrange(year, month)[1]:
                continue
            holiday = date(year, month, day)
            if holiday.weekday() == 5:
                holiday -= timedelta(days=1)
            elif holiday.weekday() == 6:
                holiday += timedelta(days=1)
            days.add(holiday)
        else:
            _, ordinal, weekday, month = rule
            matches = [d for d in range(1, calendar.monthrange(year, month)[1] + 1) if date(year, month, d).weekday() == weekday]
            if ordinal == -1:
                days.add(date(year, month, matches[-1]))
            elif ordinal <= len(matches):
                days.add(date(year, month, matches[ordinal - 1]))
    return days


def holidays_in(year, rules):
    return sorted(_holidays(year, _parse(rules)))


def _holidays(year, parsed):
    """The observed dates that fall in a year: its own holidays', and the neighbouring years'."""
    return {day for y in (year - 1, year, year + 1) for day in _observed(y, parsed) if day.year == year}


class _Calendar:
    def __init__(self, rules):
        self.parsed = _parse(rules)
        self.years = {}

    def is_business_day(self, day):
        if day.weekday() >= 5:
            return False
        if day.year not in self.years:
            self.years[day.year] = _holidays(day.year, self.parsed)
        return day not in self.years[day.year]


def add_business_days(start, n, rules):
    cal = _Calendar(rules)
    day = start
    if n == 0:
        while not cal.is_business_day(day):
            day += timedelta(days=1)
        return day
    step = timedelta(days=1 if n > 0 else -1)
    remaining = abs(n)
    while remaining:
        day += step
        if cal.is_business_day(day):
            remaining -= 1
    return day


def business_days_between(start, end, rules):
    cal = _Calendar(rules)
    if end < start:
        return -business_days_between(end, start, rules)
    count = 0
    day = start
    while day < end:
        day += timedelta(days=1)
        count += cal.is_business_day(day)
    return count
