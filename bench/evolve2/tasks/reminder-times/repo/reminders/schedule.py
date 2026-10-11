from datetime import timedelta, timezone
from zoneinfo import ZoneInfo


def upcoming(reminder, after, count=5):
    """The next `count` times the reminder rings after `after` (an aware datetime), in UTC."""
    zone = ZoneInfo(reminder.zone)
    hour, minute = (int(part) for part in reminder.time.split(":"))
    first = after.astimezone(zone).replace(hour=hour, minute=minute, second=0, microsecond=0)
    moment = first.astimezone(timezone.utc)
    if moment <= after:
        moment += timedelta(days=1)
    times = []
    while len(times) < count:
        if reminder.days == "daily" or moment.weekday() < 5:
            times.append(moment)
        moment += timedelta(days=1)
    return times
