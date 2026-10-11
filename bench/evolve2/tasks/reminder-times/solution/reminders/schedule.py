from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


def upcoming(reminder, after, count=5):
    """The next `count` times the reminder rings after `after` (an aware datetime), in UTC.

    Each day is worked out in the reminder's own time zone, so it rings at the same local time
    whatever the clocks do, and "weekdays" means the local day.
    """
    zone = ZoneInfo(reminder.zone)
    hour, minute = (int(part) for part in reminder.time.split(":"))
    day = after.astimezone(zone).date()
    times = []
    while len(times) < count:
        local = datetime.combine(day, time(hour, minute), tzinfo=zone)
        moment = local.astimezone(timezone.utc)
        if moment > after and (reminder.days == "daily" or local.weekday() < 5):
            times.append(moment)
        day += timedelta(days=1)
    return times
