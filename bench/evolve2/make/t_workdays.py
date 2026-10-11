import importlib.util
from datetime import date
from maketask import task

spec = importlib.util.spec_from_file_location("w", "workdays_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
US = ["01-01", "3rd Monday of January", "last Monday of May", "07-04", "1st Monday of September", "4th Thursday of November", "12-25"]
HOLIDAYS = [(2021, US), (2022, US), (2023, US), (2027, US), (2021, ["12-24", "12-25"]), (2022, ["12-24", "12-25"]), (2008, ["5th Friday of February"]), (2024, ["5th Friday of February"]),
            (2024, ["02-29"]), (2023, ["02-29"]), (2032, ["02-29"]), (2024, []), (2024, ["last Sunday of March", "1st Saturday of June"])]
ADD = [("2021-12-23", n, US) for n in (1, 2, 4, 5, 0, -1, -3)] + [("2022-01-03", -1, US), ("2021-12-25", 0, US), ("2021-12-25", 1, US), ("2021-12-25", -1, US), ("2021-11-24", 1, US),
       ("2021-12-31", 254, US), ("2022-12-30", -254, US), ("2024-01-05", 1, []), ("2024-01-06", 0, []), ("2023-12-29", 1, US), ("2027-12-30", 1, US)]
BETWEEN = [("2021-12-23", "2022-01-03", US), ("2022-01-03", "2021-12-23", US), ("2021-12-23", "2021-12-23", US), ("2021-12-31", "2022-12-31", US), ("2021-12-25", "2021-12-27", US),
           ("2024-01-01", "2024-01-08", []), ("2021-12-24", "2021-12-31", US), ("2027-12-23", "2028-01-04", US)]
INVALID = ["13-01", "02-30", "00-10", "1st Funday of May", "6th Monday of May", "first Monday of May", "3rd monday of january", "1-1", "12/25", 1225, "last Monday of Mayday"]
for rule in INVALID:
    try:
        m.holidays_in(2024, [rule]); raise SystemExit(f"accepted {rule!r}")
    except ValueError:
        pass

d = date.fromisoformat
hidden = f'''
import unittest
from datetime import date, timedelta

from workdays import add_business_days, business_days_between, holidays_in

d = date.fromisoformat


class TestSpec(unittest.TestCase):
    def test_holidays_in_a_year(self):
        for year, rules, expected in {[(y, r, [x.isoformat() for x in m.holidays_in(y, r)]) for y, r in HOLIDAYS]!r}:
            with self.subTest(year=year, rules=rules):
                self.assertEqual([day.isoformat() for day in holidays_in(year, rules)], expected)

    def test_adding_business_days(self):
        for start, n, rules, expected in {[(s, n, r, m.add_business_days(d(s), n, r).isoformat()) for s, n, r in ADD]!r}:
            with self.subTest(start=start, n=n, rules=rules):
                self.assertEqual(add_business_days(d(start), n, rules), d(expected))

    def test_counting_business_days(self):
        for start, end, rules, expected in {[(s, e, r, m.business_days_between(d(s), d(e), r)) for s, e, r in BETWEEN]!r}:
            with self.subTest(start=start, end=end, rules=rules):
                self.assertEqual(business_days_between(d(start), d(end), rules), expected)

    def test_adding_what_was_counted(self):
        rules = {US!r}
        start = date(2021, 11, 20)
        for days in range(0, 80, 3):
            end = start + timedelta(days=days)
            if end.weekday() < 5 and end not in holidays_in(end.year, rules):
                with self.subTest(end=end):
                    self.assertEqual(add_business_days(start, business_days_between(start, end, rules), rules), end)

    def test_invalid_rules(self):
        for rule in {INVALID!r}:
            with self.subTest(rule=rule):
                with self.assertRaises(ValueError):
                    holidays_in(2024, [rule])
                with self.assertRaises(ValueError):
                    add_business_days(date(2024, 1, 2), 1, [rule])


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
# Business days

`workdays.py` counts business days, with holidays given as rules:

- `holidays_in(year, rules)`: the holidays observed in a year, sorted;
- `add_business_days(start, n, rules)`: the date n business days from `start`;
- `business_days_between(start, end, rules)`: the business days from `start` to `end`.

Dates are `datetime.date`s. A business day is a Monday to Friday that isn't an observed holiday.

## Rules

1. A rule is a string: either a fixed date `MM-DD` (`01-01`, `12-25`), or a weekday of a month,
   `<ordinal> <Weekday> of <Month>`, where the ordinal is `1st`, `2nd`, `3rd`, `4th`, `5th` or `last`, and
   the weekday and the month are written in full, with a capital (`3rd Monday of January`, `last Monday
   of May`). Anything else raises `ValueError`, and so does a fixed date that no year has (`02-30`,
   `13-01`).
2. A fixed date that falls on a Saturday is observed on the Friday before it, and one on a Sunday on the
   Monday after it; any other on the day itself. So a holiday can be observed in the year before its own
   (January 1 on a Saturday is observed on December 31) or the year after. `02-29` is a holiday only in
   leap years.
3. A weekday of a month is observed on that day: the nth such weekday of the month, or the last. A month
   without a 5th one has no holiday from that rule that year.
4. `holidays_in(year, rules)` is the sorted list of the observed dates that fall in `year`, whichever
   year their holiday was in, each date once (two holidays observed on the same day are one date).

## Counting

5. `add_business_days(start, n, rules)`: for n > 0, the nth business day after `start` (`start` itself
   isn't counted); for n < 0, the nth business day before it, counting back; for n = 0, `start` if it is a
   business day, and otherwise the first business day after it.
6. `business_days_between(start, end, rules)`: the number of business days after `start` up to and
   including `end`, or, if `end` is before `start`, the negative of `business_days_between(end, start,
   rules)`. So for `start <= end` with `end` a business day, adding the count to `start` gives `end`.
'''

task(
    "business-days",
    "Implement holidays_in, add_business_days and business_days_between in workdays.py so that they follow SPEC.md exactly.",
    ["python", "spec", "dates"],
    {
        "SPEC.md": SPEC,
        "workdays.py": '''
            def holidays_in(year, rules):
                """The holidays observed in a year, sorted. See SPEC.md."""
                raise NotImplementedError


            def add_business_days(start, n, rules):
                """The date n business days from start. See SPEC.md."""
                raise NotImplementedError


            def business_days_between(start, end, rules):
                """How many business days there are from start to end. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_workdays.py": '''
            import unittest
            from datetime import date

            from workdays import add_business_days, business_days_between, holidays_in


            class TestBasics(unittest.TestCase):
                def test_a_weekend(self):
                    self.assertEqual(add_business_days(date(2024, 1, 5), 1, []), date(2024, 1, 8))

                def test_a_holiday(self):
                    self.assertEqual(holidays_in(2024, ["07-04"]), [date(2024, 7, 4)])
                    self.assertEqual(business_days_between(date(2024, 7, 3), date(2024, 7, 5), ["07-04"]), 1)


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"workdays.py": open("workdays_solution.py").read()},
)
