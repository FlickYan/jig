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
