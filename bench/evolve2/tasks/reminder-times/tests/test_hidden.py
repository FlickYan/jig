import unittest
from datetime import datetime, timezone

from reminders.model import Reminder
from reminders.notify import describe
from reminders.schedule import upcoming

EXPECTED = {'test_the_same_local_time_after_the_clocks_go_forward': [('09:00', 'Europe/London', 'daily', '2024-03-29T12:00', 5, ['2024-03-30T09:00:00+00:00', '2024-03-31T08:00:00+00:00', '2024-04-01T08:00:00+00:00', '2024-04-02T08:00:00+00:00', '2024-04-03T08:00:00+00:00']), ('07:30', 'America/New_York', 'daily', '2024-03-08T20:00', 4, ['2024-03-09T12:30:00+00:00', '2024-03-10T11:30:00+00:00', '2024-03-11T11:30:00+00:00', '2024-03-12T11:30:00+00:00'])], 'test_the_same_local_time_after_the_clocks_go_back': [('09:00', 'Europe/London', 'daily', '2024-10-25T12:00', 4, ['2024-10-26T08:00:00+00:00', '2024-10-27T09:00:00+00:00', '2024-10-28T09:00:00+00:00', '2024-10-29T09:00:00+00:00']), ('06:45', 'Australia/Sydney', 'daily', '2024-04-05T00:00', 4, ['2024-04-05T19:45:00+00:00', '2024-04-06T20:45:00+00:00', '2024-04-07T20:45:00+00:00', '2024-04-08T20:45:00+00:00'])], 'test_weekdays_are_local_days': [('08:00', 'Pacific/Auckland', 'weekdays', '2024-03-07T00:00', 6, ['2024-03-07T19:00:00+00:00', '2024-03-10T19:00:00+00:00', '2024-03-11T19:00:00+00:00', '2024-03-12T19:00:00+00:00', '2024-03-13T19:00:00+00:00', '2024-03-14T19:00:00+00:00']), ('04:00', 'Asia/Kolkata', 'weekdays', '2024-03-08T00:00', 5, ['2024-03-10T22:30:00+00:00', '2024-03-11T22:30:00+00:00', '2024-03-12T22:30:00+00:00', '2024-03-13T22:30:00+00:00', '2024-03-14T22:30:00+00:00']), ('23:30', 'America/Los_Angeles', 'weekdays', '2024-03-08T00:00', 5, ['2024-03-08T07:30:00+00:00', '2024-03-09T07:30:00+00:00', '2024-03-12T06:30:00+00:00', '2024-03-13T06:30:00+00:00', '2024-03-14T06:30:00+00:00'])], 'test_weekdays_across_a_change_of_clocks': [('08:00', 'Pacific/Auckland', 'weekdays', '2024-04-03T00:00', 6, ['2024-04-03T19:00:00+00:00', '2024-04-04T19:00:00+00:00', '2024-04-07T20:00:00+00:00', '2024-04-08T20:00:00+00:00', '2024-04-09T20:00:00+00:00', '2024-04-10T20:00:00+00:00']), ('09:00', 'Europe/Berlin', 'weekdays', '2024-03-27T00:00', 5, ['2024-03-27T08:00:00+00:00', '2024-03-28T08:00:00+00:00', '2024-03-29T08:00:00+00:00', '2024-04-01T07:00:00+00:00', '2024-04-02T07:00:00+00:00'])], 'test_strictly_after': [('09:00', 'Europe/London', 'daily', '2024-06-10T08:00', 2, ['2024-06-11T08:00:00+00:00', '2024-06-12T08:00:00+00:00']), ('12:00', 'Asia/Tokyo', 'daily', '2024-06-10T03:00', 2, ['2024-06-11T03:00:00+00:00', '2024-06-12T03:00:00+00:00']), ('00:00', 'UTC', 'daily', '2024-12-31T00:00', 2, ['2025-01-01T00:00:00+00:00', '2025-01-02T00:00:00+00:00'])]}


def utc(text):
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


class TestIssues(unittest.TestCase):
    """Every expected time here was worked out with Python's zoneinfo."""

    def check(self, method):
        for time, zone, days, after, count, expected in EXPECTED[method]:
            with self.subTest(time=time, zone=zone, days=days, after=after):
                got = upcoming(Reminder(time, zone, days), utc(after), count)
                self.assertEqual([moment.astimezone(timezone.utc).isoformat() for moment in got], expected)
                self.assertTrue(all(moment.utcoffset().total_seconds() == 0 for moment in got), "times are in UTC")

    def test_the_same_local_time_after_the_clocks_go_forward(self):
        self.check('test_the_same_local_time_after_the_clocks_go_forward')

    def test_the_same_local_time_after_the_clocks_go_back(self):
        self.check('test_the_same_local_time_after_the_clocks_go_back')

    def test_weekdays_are_local_days(self):
        self.check('test_weekdays_are_local_days')

    def test_weekdays_across_a_change_of_clocks(self):
        self.check('test_weekdays_across_a_change_of_clocks')

    def test_strictly_after(self):
        self.check('test_strictly_after')


class TestUnchanged(unittest.TestCase):
    def test_describe(self):
        self.assertEqual(describe(Reminder("09:00", "Europe/London"), utc("2024-06-10T12:00")), "next: 2024-06-11 08:00 UTC")

    def test_a_bad_time(self):
        with self.assertRaises(ValueError):
            upcoming(Reminder("9am", "Europe/London"), utc("2024-06-10T12:00"))


if __name__ == "__main__":
    unittest.main()
