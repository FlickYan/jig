from datetime import datetime, timedelta

MONTHS = {name: i for i, name in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
DAYS = {name: i for i, name in enumerate(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])}
FIELDS = [(0, 59, {}), (0, 23, {}), (1, 31, {}), (1, 12, MONTHS), (0, 7, DAYS)]


def _number(text, names):
    if text.upper() in names:
        return names[text.upper()]
    if not text.isdigit():
        raise ValueError(f"not a value: {text!r}")
    return int(text)


def _field(text, low, high, names):
    values = set()
    for item in text.split(","):
        base, _, step = item.partition("/")
        if step:
            if not step.isdigit() or int(step) == 0:
                raise ValueError(f"bad step in {item!r}")
        every = int(step) if step else 1
        if base == "*":
            first, last = low, high
        elif "-" in base:
            a, b = base.split("-", 1)
            first, last = _number(a, names), _number(b, names)
        else:
            first = _number(base, names)
            last = high if step else first
        if not (low <= first <= high and low <= last <= high) or first > last:
            raise ValueError(f"out of range: {item!r}")
        values.update(range(first, last + 1, every))
    return values


def next_run(expression, after):
    """The first time strictly after `after` at which `expression` fires. See SPEC.md."""
    parts = expression.split()
    if len(parts) != 5:
        raise ValueError(f"a cron expression has five fields: {expression!r}")
    minutes, hours, days, months, weekdays = (_field(p, low, high, names) for p, (low, high, names) in zip(parts, FIELDS))
    weekdays = {0 if d == 7 else d for d in weekdays}
    day_restricted, week_restricted = parts[2] != "*", parts[4] != "*"

    def day_matches(moment):
        weekday = (moment.weekday() + 1) % 7
        if day_restricted and week_restricted:
            return moment.day in days or weekday in weekdays
        if day_restricted:
            return moment.day in days
        if week_restricted:
            return weekday in weekdays
        return True

    moment = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = after + timedelta(days=366 * 5)
    while moment <= limit:
        if moment.month not in months:
            moment = (moment.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
            continue
        if not day_matches(moment):
            moment = moment.replace(hour=0, minute=0) + timedelta(days=1)
            continue
        if moment.hour not in hours:
            moment = moment.replace(minute=0) + timedelta(hours=1)
            continue
        if moment.minute not in minutes:
            moment += timedelta(minutes=1)
            continue
        return moment
    raise ValueError(f"{expression!r} never fires")
