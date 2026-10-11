import json
from maketask import task
from rrulecases import INVALID

expected = json.load(open("rrule-expected.json"))
methods = []
for group, rows in expected.items():
    body = "\n".join(f"            ({rule!r}, {start!r}, {limit!r}, {want!r})," for rule, start, limit, want in rows)
    methods.append(f"    def {group}(self):\n        self.check([\n{body}\n        ])\n")
methods.append("    def test_invalid_rules(self):\n        for rule in " + repr(INVALID) + ":\n            with self.subTest(rule=rule):\n                with self.assertRaises(ValueError):\n                    occurrences(rule, date(2024, 1, 1))\n")

hidden = '''
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

''' + "\n".join(methods) + '''

if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
# occurrences(rule, start, limit=100) -> list[date]

The dates a recurrence rule produces, in order, from `start` (a `datetime.date`), for a subset of the
RRULE of iCalendar (RFC 5545), without times. `rule` is parts `NAME=VALUE` separated by `;`, in any
order. A rule that isn't valid raises `ValueError`.

## Parts

1. `FREQ` (required): `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY`, the kind of period the rule repeats in.
   Weeks start on Monday.
2. `INTERVAL`: a positive integer, 1 by default. The rule applies to every INTERVAL-th period, counting
   from the period that contains `start`.
3. `COUNT`: a positive integer, the most dates to produce. `UNTIL`: a date `YYYYMMDD`, the last day a
   date may fall on. They can't both be given. With neither, at most `limit` dates are produced.
4. `BYMONTH`: months, 1 to 12.
5. `BYMONTHDAY`: days of the month, 1 to 31, or -31 to -1 counting from the end (-1 is the last day).
   Not allowed with `FREQ=WEEKLY`.
6. `BYDAY`: days of the week, `MO`, `TU`, `WE`, `TH`, `FR`, `SA` and `SU`, each optionally after a signed
   ordinal from 1 to 53: `2TU` is the second Tuesday and `-1FR` the last Friday of the month (in a
   `MONTHLY` rule, or a `YEARLY` one with `BYMONTH`) or of the year (in a `YEARLY` rule without
   `BYMONTH`). Ordinals are allowed only with `FREQ=MONTHLY` or `YEARLY`.
7. `BYSETPOS`: positions, 1 to 366 or -366 to -1. Of the dates a period has after the other parts, in
   order, only those at these positions are kept (1 is the first, -1 the last; a position the period
   doesn't have keeps nothing). Allowed only with `FREQ=MONTHLY` or `YEARLY`.

Lists are comma-separated. Each part may appear only once; any other part, a part without a value, and
any value other than those above, are invalid.

## Which dates

8. Each period the rule applies to has these dates: its days (a `DAILY` period is one day), less those
   not in `BYMONTH`'s months, not on `BYMONTHDAY`'s days of the month, and not on `BYDAY`'s days of the
   week, for each of those parts that is given.
9. Parts that aren't given take their days from `start`. A `WEEKLY` rule without `BYDAY` has only the
   days with `start`'s weekday. A `MONTHLY` or `YEARLY` rule with neither `BYMONTHDAY` nor `BYDAY` has
   only the days with `start`'s day of the month and, for a `YEARLY` rule without `BYMONTH`, only in
   `start`'s month. (So `FREQ=MONTHLY` from January 31 skips the months without a 31st, and
   `FREQ=YEARLY` from February 29 has a date only in leap years.)
10. `BYSETPOS`, if given, then picks from each period's dates.
11. The result is the dates of all the periods, in order, leaving out those before `start`: `start` is
    one of the dates only if it fits the rule. It stops at `COUNT` dates, after `UNTIL` (which is
    included), or, without either, at `limit` dates.
'''

task(
    "rrule-dates",
    "Implement occurrences in recurrence.py so that it follows SPEC.md exactly.",
    ["python", "spec", "dates"],
    {
        "SPEC.md": SPEC,
        "recurrence.py": '''
            def occurrences(rule, start, limit=100):
                """The dates a recurrence rule produces, from start (a datetime.date), in order. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_recurrence.py": '''
            import unittest
            from datetime import date

            from recurrence import occurrences


            class TestBasics(unittest.TestCase):
                def test_daily(self):
                    self.assertEqual(occurrences("FREQ=DAILY;COUNT=3", date(2024, 1, 1)), [date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3)])

                def test_weekly_on_days(self):
                    self.assertEqual(occurrences("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3", date(2024, 1, 1)), [date(2024, 1, 1), date(2024, 1, 3), date(2024, 1, 8)])

                def test_invalid(self):
                    with self.assertRaises(ValueError):
                        occurrences("FREQ=SOMETIMES", date(2024, 1, 1))


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"recurrence.py": open("rrule_solution.py").read()},
)
