import unittest
from datetime import date

from recurrence import occurrences


class TestSpec(unittest.TestCase):
    """Every expected list here is what python-dateutil's rrule makes of the same rule."""

    def check(self, cases):
        for rule, start, limit, expected in cases:
            with self.subTest(rule=rule, start=start, limit=limit):
                got = occurrences(rule, date.fromisoformat(start), limit)
                self.assertEqual([day.isoformat() for day in got], expected)
                self.assertTrue(all(type(day) is date for day in got))

    def test_daily_count_interval_and_limit(self):
        self.check([
            ('FREQ=DAILY;COUNT=5', '2024-01-30', 100, ['2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02', '2024-02-03']),
            ('FREQ=DAILY;INTERVAL=10;COUNT=4', '2024-02-25', 100, ['2024-02-25', '2024-03-06', '2024-03-16', '2024-03-26']),
            ('FREQ=DAILY', '2024-12-30', 3, ['2024-12-30', '2024-12-31', '2025-01-01']),
            ('COUNT=3;FREQ=DAILY;INTERVAL=2', '2024-02-28', 100, ['2024-02-28', '2024-03-01', '2024-03-03']),
        ])

    def test_until_is_inclusive(self):
        self.check([
            ('FREQ=DAILY;UNTIL=20240105', '2024-01-01', 100, ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']),
            ('FREQ=WEEKLY;UNTIL=20240129', '2024-01-01', 100, ['2024-01-01', '2024-01-08', '2024-01-15', '2024-01-22', '2024-01-29']),
            ('FREQ=DAILY;UNTIL=20231231', '2024-01-01', 100, []),
        ])

    def test_start_counts_only_if_it_fits(self):
        self.check([
            ('FREQ=WEEKLY;BYDAY=MO;COUNT=3', '2024-01-03', 100, ['2024-01-08', '2024-01-15', '2024-01-22']),
            ('FREQ=MONTHLY;BYMONTHDAY=1;COUNT=2', '2024-01-15', 100, ['2024-02-01', '2024-03-01']),
            ('FREQ=WEEKLY;BYDAY=WE;COUNT=2', '2024-01-03', 100, ['2024-01-03', '2024-01-10']),
        ])

    def test_weekly(self):
        self.check([
            ('FREQ=WEEKLY;COUNT=3', '2024-02-28', 100, ['2024-02-28', '2024-03-06', '2024-03-13']),
            ('FREQ=WEEKLY;BYDAY=TU,TH;COUNT=5', '2024-01-01', 100, ['2024-01-02', '2024-01-04', '2024-01-09', '2024-01-11', '2024-01-16']),
            ('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=5', '2024-01-03', 100, ['2024-01-05', '2024-01-15', '2024-01-19', '2024-01-29', '2024-02-02']),
            ('FREQ=WEEKLY;BYMONTH=2;COUNT=5', '2024-01-25', 100, ['2024-02-01', '2024-02-08', '2024-02-15', '2024-02-22', '2024-02-29']),
        ])

    def test_monthly_by_day_of_month(self):
        self.check([
            ('FREQ=MONTHLY;COUNT=5', '2024-01-31', 100, ['2024-01-31', '2024-03-31', '2024-05-31', '2024-07-31', '2024-08-31']),
            ('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4', '2024-01-15', 100, ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']),
            ('FREQ=MONTHLY;BYMONTHDAY=1,-1;COUNT=4', '2024-01-15', 100, ['2024-01-31', '2024-02-01', '2024-02-29', '2024-03-01']),
            ('FREQ=MONTHLY;BYMONTHDAY=30;COUNT=3', '2024-01-30', 100, ['2024-01-30', '2024-03-30', '2024-04-30']),
        ])

    def test_monthly_by_weekday(self):
        self.check([
            ('FREQ=MONTHLY;BYDAY=2TU;COUNT=4', '2024-01-01', 100, ['2024-01-09', '2024-02-13', '2024-03-12', '2024-04-09']),
            ('FREQ=MONTHLY;BYDAY=-1FR;COUNT=4', '2024-01-01', 100, ['2024-01-26', '2024-02-23', '2024-03-29', '2024-04-26']),
            ('FREQ=MONTHLY;BYDAY=1MO,-1MO;COUNT=4', '2024-01-02', 100, ['2024-01-29', '2024-02-05', '2024-02-26', '2024-03-04']),
            ('FREQ=MONTHLY;BYDAY=+3WE;COUNT=2', '2024-01-01', 100, ['2024-01-17', '2024-02-21']),
            ('FREQ=MONTHLY;INTERVAL=3;BYDAY=1MO;COUNT=4', '2024-01-20', 100, ['2024-04-01', '2024-07-01', '2024-10-07', '2025-01-06']),
            ('FREQ=MONTHLY;BYDAY=SA,SU;COUNT=5', '2024-02-20', 100, ['2024-02-24', '2024-02-25', '2024-03-02', '2024-03-03', '2024-03-09']),
        ])

    def test_both_day_parts_must_match(self):
        self.check([
            ('FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=4', '2024-01-01', 100, ['2024-09-13', '2024-12-13', '2025-06-13', '2026-02-13']),
            ('FREQ=MONTHLY;BYMONTH=3,6,9,12;BYMONTHDAY=1;COUNT=4', '2024-01-01', 100, ['2024-03-01', '2024-06-01', '2024-09-01', '2024-12-01']),
        ])

    def test_setpos(self):
        self.check([
            ('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4', '2024-01-01', 100, ['2024-01-31', '2024-02-29', '2024-03-29', '2024-04-30']),
            ('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1;COUNT=4', '2024-01-01', 100, ['2024-01-01', '2024-01-31', '2024-02-01', '2024-02-29']),
            ('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=5;COUNT=3', '2024-01-01', 100, ['2024-01-29', '2024-04-29', '2024-07-29']),
            ('FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=2;COUNT=3', '2024-01-10', 100, ['2024-02-04', '2024-03-03', '2024-04-07']),
            ('FREQ=YEARLY;BYMONTH=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', '2024-01-01', 100, ['2024-03-29', '2025-03-31', '2026-03-31']),
        ])

    def test_yearly(self):
        self.check([
            ('FREQ=YEARLY;COUNT=3', '2024-02-29', 100, ['2024-02-29', '2028-02-29', '2032-02-29']),
            ('FREQ=YEARLY;BYMONTH=1,7;COUNT=4', '2024-03-10', 100, ['2024-07-10', '2025-01-10', '2025-07-10', '2026-01-10']),
            ('FREQ=YEARLY;BYMONTHDAY=15;COUNT=3', '2024-01-20', 100, ['2024-02-15', '2024-03-15', '2024-04-15']),
            ('FREQ=YEARLY;BYMONTH=2;BYDAY=SU;COUNT=5', '2024-01-01', 100, ['2024-02-04', '2024-02-11', '2024-02-18', '2024-02-25', '2025-02-02']),
            ('FREQ=YEARLY;INTERVAL=2;BYMONTH=6;BYMONTHDAY=1;COUNT=3', '2024-07-01', 100, ['2026-06-01', '2028-06-01', '2030-06-01']),
        ])

    def test_yearly_ordinals_count_in_the_year_or_the_month(self):
        self.check([
            ('FREQ=YEARLY;BYDAY=20MO;COUNT=3', '2024-01-01', 100, ['2024-05-13', '2025-05-19', '2026-05-18']),
            ('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3', '2024-01-01', 100, ['2024-11-28', '2025-11-27', '2026-11-26']),
            ('FREQ=YEARLY;BYDAY=-1SU;COUNT=2', '2024-01-01', 100, ['2024-12-29', '2025-12-28']),
            ('FREQ=YEARLY;BYDAY=1MO;COUNT=3', '2024-03-01', 100, ['2025-01-06', '2026-01-05', '2027-01-04']),
        ])

    def test_daily_with_filters(self):
        self.check([
            ('FREQ=DAILY;BYDAY=MO,WE,FR;COUNT=5', '2024-01-05', 100, ['2024-01-05', '2024-01-08', '2024-01-10', '2024-01-12', '2024-01-15']),
            ('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;COUNT=2', '2024-01-01', 100, ['2024-02-29', '2028-02-29']),
            ('FREQ=DAILY;BYMONTHDAY=-1;COUNT=3', '2024-01-01', 100, ['2024-01-31', '2024-02-29', '2024-03-31']),
        ])

    def test_invalid_rules(self):
        for rule in ['', 'COUNT=3', 'FREQ=HOURLY', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;INTERVAL=x', 'FREQ=DAILY;COUNT=3;UNTIL=20240101', 'FREQ=MONTHLY;BYMONTH=13', 'FREQ=MONTHLY;BYMONTH=0', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=MONTHLY;BYMONTHDAY=32', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=DAILY;BYDAY=-1FR', 'FREQ=MONTHLY;BYDAY=XX', 'FREQ=MONTHLY;BYDAY=0MO', 'FREQ=MONTHLY;BYDAY=54MO', 'FREQ=WEEKLY;BYMONTHDAY=1', 'FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1', 'FREQ=DAILY;BYSETPOS=1', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=367', 'FREQ=DAILY;UNTIL=2024-01-01', 'FREQ=DAILY;WKST=MO', 'FREQ=DAILY;COUNT', 'FREQ=DAILY;BYMONTH=']:
            with self.subTest(rule=rule):
                with self.assertRaises(ValueError):
                    occurrences(rule, date(2024, 1, 1))


if __name__ == "__main__":
    unittest.main()
