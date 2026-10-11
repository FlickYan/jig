"""What a week of shifts pays. See SPEC.md."""
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
import re

TIME = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}")


def weekly_pay(shifts, rate, holidays=()):
    rate = Decimal(str(rate))
    holiday_dates = set()
    for text in holidays:
        if not isinstance(text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            raise ValueError(f"not a date: {text!r}")
        holiday_dates.add(date.fromisoformat(text))
    parsed = sorted((_time(start), _time(end)) for start, end in shifts)
    for start, end in parsed:
        if not start < end <= start + timedelta(hours=24):
            raise ValueError(f"a shift must end after it starts, within 24 hours: {start} to {end}")
    for (_, end), (start, _) in zip(parsed, parsed[1:]):
        if start < end:
            raise ValueError("shifts overlap")
    monday = None
    if parsed:
        monday = parsed[0][0].date() - timedelta(days=parsed[0][0].weekday())
        if any((start.date() - monday).days >= 7 for start, _ in parsed):
            raise ValueError("the shifts aren't all in one week")
    days = defaultdict(Decimal)
    call_in = Decimal(0)
    for start, end in parsed:
        hours = Decimal((_round(end) - _round(start)) // timedelta(minutes=15)) / 4
        if hours > 6:
            hours -= Decimal("0.5")
        if hours < 3:
            call_in += 3 - hours
        days[start.weekday()] += hours
    regular = overtime = double = week_regular = Decimal(0)
    for day in range(7):
        hours = days.get(day, Decimal(0))
        if monday is not None and monday + timedelta(days=day) in holiday_dates:
            double += hours
            continue
        if len(days) == 7 and day == 6:
            overtime += min(hours, Decimal(8))
            double += max(hours - 8, Decimal(0))
            continue
        day_regular = min(hours, Decimal(8))
        moved = max(day_regular - max(Decimal(40) - week_regular, Decimal(0)), Decimal(0))
        week_regular += day_regular - moved
        regular += day_regular - moved
        overtime += min(max(hours - 8, Decimal(0)), Decimal(4)) + moved
        double += max(hours - 12, Decimal(0))
    pay = ((regular + call_in) * rate + overtime * rate * Decimal("1.5") + double * rate * 2).quantize(Decimal("0.01"), ROUND_HALF_UP)
    return {"regular": regular, "overtime": overtime, "double": double, "call_in": call_in, "pay": pay}


def _time(text):
    if not isinstance(text, str) or not TIME.fullmatch(text):
        raise ValueError(f"not a time: {text!r}")
    return datetime.strptime(text, "%Y-%m-%d %H:%M")


def _round(moment):
    past = moment.minute % 15
    return moment - timedelta(minutes=past) if past <= 7 else moment + timedelta(minutes=15 - past)
