import importlib.util, sys, textwrap, types
from datetime import datetime, timezone
from maketask import task

MODEL = '''
    from dataclasses import dataclass


    @dataclass
    class Reminder:
        time: str  # "HH:MM", in the reminder's time zone
        zone: str  # an IANA time zone, like "Europe/London"
        days: str = "daily"  # "daily", or "weekdays" (Monday to Friday)
'''
SCHEDULE_BUGGY = '''
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
'''
SCHEDULE_FIXED = '''
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
'''
NOTIFY = '''
    from .schedule import upcoming


    def describe(reminder, after):
        """A line for the app: when the reminder rings next, in UTC."""
        moment = upcoming(reminder, after, count=1)[0]
        return f"next: {moment:%Y-%m-%d %H:%M} UTC"
'''

# The fixed version, loaded here to compute what the hidden tests expect.
pkg = types.ModuleType("reminders"); pkg.__path__ = []; sys.modules["reminders"] = pkg
for name, src in (("model", MODEL), ("schedule", SCHEDULE_FIXED)):
    module = types.ModuleType(f"reminders.{name}"); module.__package__ = "reminders"; sys.modules[f"reminders.{name}"] = module
    exec(compile(textwrap.dedent(src), name, "exec"), module.__dict__)
Reminder, upcoming = sys.modules["reminders.model"].Reminder, sys.modules["reminders.schedule"].upcoming
U = lambda text: datetime.fromisoformat(text).replace(tzinfo=timezone.utc)
CASES = {
    "test_the_same_local_time_after_the_clocks_go_forward": [("09:00", "Europe/London", "daily", "2024-03-29T12:00", 5), ("07:30", "America/New_York", "daily", "2024-03-08T20:00", 4)],
    "test_the_same_local_time_after_the_clocks_go_back": [("09:00", "Europe/London", "daily", "2024-10-25T12:00", 4), ("06:45", "Australia/Sydney", "daily", "2024-04-05T00:00", 4)],
    "test_weekdays_are_local_days": [("08:00", "Pacific/Auckland", "weekdays", "2024-03-07T00:00", 6), ("04:00", "Asia/Kolkata", "weekdays", "2024-03-08T00:00", 5), ("23:30", "America/Los_Angeles", "weekdays", "2024-03-08T00:00", 5)],
    "test_weekdays_across_a_change_of_clocks": [("08:00", "Pacific/Auckland", "weekdays", "2024-04-03T00:00", 6), ("09:00", "Europe/Berlin", "weekdays", "2024-03-27T00:00", 5)],
    "test_strictly_after": [("09:00", "Europe/London", "daily", "2024-06-10T08:00", 2), ("12:00", "Asia/Tokyo", "daily", "2024-06-10T03:00", 2), ("00:00", "UTC", "daily", "2024-12-31T00:00", 2)],
}
EXPECTED = {method: [(t, z, d, a, n, [m.isoformat() for m in upcoming(Reminder(t, z, d), U(a), n)]) for t, z, d, a, n in cases] for method, cases in CASES.items()}
for method, rows in EXPECTED.items():
    print(method, rows[0][-1][:3])

HEAD = """
import unittest
from datetime import datetime, timezone

from reminders.model import Reminder
from reminders.notify import describe
from reminders.schedule import upcoming

EXPECTED = EXPECTED_HERE


def utc(text):
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


class TestIssues(unittest.TestCase):
    \"\"\"Every expected time here was worked out with Python's zoneinfo.\"\"\"

    def check(self, method):
        for time, zone, days, after, count, expected in EXPECTED[method]:
            with self.subTest(time=time, zone=zone, days=days, after=after):
                got = upcoming(Reminder(time, zone, days), utc(after), count)
                self.assertEqual([moment.astimezone(timezone.utc).isoformat() for moment in got], expected)
                self.assertTrue(all(moment.utcoffset().total_seconds() == 0 for moment in got), "times are in UTC")

"""
TAIL = """

class TestUnchanged(unittest.TestCase):
    def test_describe(self):
        self.assertEqual(describe(Reminder("09:00", "Europe/London"), utc("2024-06-10T12:00")), "next: 2024-06-11 08:00 UTC")

    def test_a_bad_time(self):
        with self.assertRaises(ValueError):
            upcoming(Reminder("9am", "Europe/London"), utc("2024-06-10T12:00"))


if __name__ == "__main__":
    unittest.main()
"""
HIDDEN = HEAD.replace("EXPECTED_HERE", repr(EXPECTED)) + "\n".join(f"    def {method}(self):\n        self.check({method!r})\n" for method in EXPECTED) + TAIL

files = {
    "ISSUE.md": '''
        # Reminders ring at the wrong times

        1. **An hour late since the clocks changed.** Ana's daily reminder for 09:00, in London, has rung
           at 10:00 every day since the clocks went forward. Reminders should ring at their time in their
           own time zone, every day, whatever the clocks do there.

        2. **Weekdays are the wrong days.** Kiri's reminder for 08:00 on weekdays, in Auckland, rings on
           Saturday mornings, and not on Monday mornings. Weekdays are Monday to Friday where the reminder
           is.
    ''',
    "reminders/__init__.py": '"""Reminders that ring at a time of day, in their own time zone."""\n',
    "reminders/model.py": MODEL,
    "reminders/schedule.py": SCHEDULE_BUGGY,
    "reminders/notify.py": NOTIFY,
    "tests/__init__.py": "",
    "tests/test_reminders.py": '''
        import unittest
        from datetime import datetime, timezone

        from reminders.model import Reminder
        from reminders.schedule import upcoming


        class TestReminders(unittest.TestCase):
            def test_daily_in_summer(self):
                after = datetime(2024, 6, 10, 12, 0, tzinfo=timezone.utc)
                times = upcoming(Reminder("09:00", "Europe/London"), after, count=2)
                self.assertEqual([t.isoformat() for t in times], ["2024-06-11T08:00:00+00:00", "2024-06-12T08:00:00+00:00"])


        if __name__ == "__main__":
            unittest.main()
    ''',
}
task(
    "reminder-times",
    "Fix the problems reported in ISSUE.md, without changing anything else about how the reminders package behaves.",
    ["python", "bugs", "dates"],
    files,
    HIDDEN,
    {"reminders/schedule.py": SCHEDULE_FIXED},
)
