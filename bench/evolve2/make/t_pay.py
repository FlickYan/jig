import importlib.util
from maketask import task

spec = importlib.util.spec_from_file_location("p", "pay_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
D = ["2024-01-%02d" % d for d in range(1, 9)]  # Monday January 1 to the next Monday


def shift(day, start, end, overnight=False):
    return (f"{D[day]} {start}", f"{D[day + 1] if overnight else D[day]} {end}")


GROUPS = {
    "test_a_plain_week": [([shift(d, "09:00", "17:30") for d in range(5)], "20")],
    "test_quarter_hour_rounding": [([shift(0, "08:52", "17:07"), shift(1, "08:53", "17:08")], "20")],
    "test_break_only_after_six_hours": [([shift(0, "09:00", "15:00")], "20"), ([shift(0, "09:00", "15:15")], "20")],
    "test_daily_overtime_and_double_time": [([shift(0, "07:00", "21:00")], "20"), ([shift(0, "06:00", "11:00"), shift(0, "13:00", "18:00")], "20"), ([shift(0, "09:00", "09:00", True)], "20")],
    "test_a_shift_belongs_to_the_day_it_starts": [([shift(4, "22:00", "07:00", True), shift(5, "10:00", "12:00")], "20"), ([shift(6, "20:00", "04:00", True)], "20")],
    "test_weekly_overtime_counts_regular_hours_only": [
        ([shift(d, "09:00", "17:30") for d in range(5)] + [shift(5, "09:00", "14:00")], "20"),
        ([shift(0, "08:00", "18:00")] + [shift(d, "09:00", "17:30") for d in range(1, 5)] + [shift(5, "09:00", "13:00")], "20"),
    ],
    "test_the_seventh_day": [
        ([shift(d, "09:00", "14:00") for d in range(7)], "20"),
        ([shift(d, "09:00", "14:00") for d in range(6)] + [shift(6, "09:00", "20:00")], "20"),
        ([shift(d, "09:00", "14:00") for d in range(6)], "20"),
    ],
    "test_pay_is_exact_and_rounded_once": [([shift(0, "09:00", "12:15")], "10.10"), ([shift(0, "07:00", "21:00")], "17.33"), ([shift(0, "09:00", "12:00"), shift(0, "12:00", "15:00")], "15.55")],
    "test_no_shifts": [([], "20")],
    "test_short_shifts_are_paid_three_hours": [([shift(0, "09:00", "10:30")], "20"), ([shift(0, "09:00", "11:00"), shift(0, "13:00", "14:00")], "20"), ([shift(0, "09:00", "09:15")], "10.10"),
                                               ([shift(d, "09:00", "17:30") for d in range(6)] + [shift(6, "09:00", "10:00")], "20")],
}
HOLIDAYS = [
    ([shift(0, "09:00", "17:30"), shift(1, "09:00", "17:30")], "20", ["2024-01-02"]),
    ([shift(d, "09:00", "14:00") for d in range(7)], "20", ["2024-01-07"]),
    ([shift(d, "08:00", "18:00") for d in range(5)], "20", ["2024-01-01"]),
    ([shift(2, "09:00", "10:00")], "20", ["2024-01-03"]),
    ([shift(0, "22:00", "07:00", True)], "20", ["2024-01-02"]),
    ([shift(0, "09:00", "17:30")], "20", ["2023-12-25", "2024-12-25"]),
]
INVALID = [
    [("2024-01-01 10:00", "2024-01-01 09:00")], [("2024-01-01 09:00", "2024-01-01 09:00")], [("2024-01-01 09:00", "2024-01-02 09:01")],
    [("2024-01-01 09:00", "2024-01-01 17:00"), ("2024-01-01 16:00", "2024-01-01 18:00")], [("2024-01-01 09:00", "2024-01-01 17:00"), ("2024-01-08 09:00", "2024-01-08 17:00")],
    [("2024-01-01T09:00", "2024-01-01 17:00")], [("2024-01-01 9:00", "2024-01-01 17:00")], [("2024-13-01 09:00", "2024-13-01 17:00")],
]
for shifts in INVALID:
    try:
        m.weekly_pay(shifts, "20")
        raise SystemExit(f"accepted {shifts}")
    except ValueError:
        pass
BAD_HOLIDAYS = [["2024-1-02"], ["Jan 2"], [20240102], ["2024-02-30"]]
for holidays in BAD_HOLIDAYS:
    try:
        m.weekly_pay([shift(0, "09:00", "17:30")], "20", holidays)
        raise SystemExit(f"accepted holidays {holidays}")
    except ValueError:
        pass

methods = []
for method, cases in GROUPS.items():
    rows = []
    for shifts, rate in cases:
        r = m.weekly_pay(shifts, rate)
        rows.append(f"            ({shifts!r}, {rate!r}, (), ({str(r['regular'])!r}, {str(r['overtime'])!r}, {str(r['double'])!r}, {str(r['call_in'])!r}, {str(r['pay'])!r})),")
    methods.append(f"    def {method}(self):\n        self.check([\n" + "\n".join(rows) + "\n        ])\n")
rows = []
for shifts, rate, holidays in HOLIDAYS:
    r = m.weekly_pay(shifts, rate, holidays)
    rows.append(f"            ({shifts!r}, {rate!r}, {holidays!r}, ({str(r['regular'])!r}, {str(r['overtime'])!r}, {str(r['double'])!r}, {str(r['call_in'])!r}, {str(r['pay'])!r})),")
methods.append("    def test_holidays_are_double_time(self):\n        self.check([\n" + "\n".join(rows) + "\n        ])\n")
methods.append("    def test_invalid_holidays(self):\n        for holidays in " + repr(BAD_HOLIDAYS) + ":\n            with self.subTest(holidays=holidays):\n                with self.assertRaises(ValueError):\n                    weekly_pay([(\"2024-01-01 09:00\", \"2024-01-01 17:30\")], \"20\", holidays)\n")
methods.append("    def test_invalid_shifts(self):\n        for shifts in " + repr(INVALID) + ":\n            with self.subTest(shifts=shifts):\n                with self.assertRaises(ValueError):\n                    weekly_pay(shifts, \"20\")\n")

hidden = '''
import unittest
from decimal import Decimal

from payroll import weekly_pay


class TestSpec(unittest.TestCase):
    def check(self, cases):
        for shifts, rate, holidays, (regular, overtime, double, call_in, pay) in cases:
            with self.subTest(shifts=shifts, rate=rate, holidays=holidays):
                result = weekly_pay(shifts, rate, holidays)
                for key in ("regular", "overtime", "double", "call_in", "pay"):
                    self.assertIsInstance(result[key], Decimal, key)
                self.assertEqual((result["regular"], result["overtime"], result["double"], result["call_in"]), (Decimal(regular), Decimal(overtime), Decimal(double), Decimal(call_in)))
                self.assertEqual(str(result["pay"]), pay)

''' + "\n".join(methods) + '''
    def test_rate_as_a_decimal(self):
        self.assertEqual(str(weekly_pay([("2024-01-01 09:00", "2024-01-01 17:30")], Decimal("12.5"))["pay"]), "100.00")


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
# weekly_pay(shifts, rate, holidays=()) -> dict

What a week of shifts pays. `shifts` is a list of `(start, end)` pairs of strings `"YYYY-MM-DD HH:MM"`;
`rate` is the hourly rate, a `Decimal` or a string like `"18.50"`; and `holidays` lists public holidays,
as strings `"YYYY-MM-DD"`. The result is a dict: the hours paid each way, `"regular"`, `"overtime"`,
`"double"` and `"call_in"`, and `"pay"`, all five `Decimal`s.

## Shifts

1. A shift ends after it starts, at most 24 hours later. Shifts may not overlap (one may start when
   another ends). All of them start in the same week, Monday to Sunday. Anything else raises
   `ValueError`, and so does a time or a holiday that isn't written as above, or isn't a real date.
2. Every start and end is rounded to the nearest quarter hour: 0 to 7 minutes past a quarter hour round
   down, and 8 to 14 round up (09:07 is 09:00, 09:08 is 09:15, 09:53 is 10:00). A shift's length is the
   time from its rounded start to its rounded end.
3. A shift longer than 6 hours has a 30-minute unpaid break: its paid hours are its length less half an
   hour. A shift of 6 hours or less is paid in full.
4. A shift belongs to the day it starts on, even when it ends after midnight. A day's hours are the paid
   hours of all its shifts.
5. A shift with fewer than 3 paid hours is paid for 3: the hours it falls short are call-in hours, paid
   at the rate (never more, whatever the day), and they aren't a day's hours: they count for nothing in
   rules 6 to 9.

## Overtime

6. On each day, the first 8 hours are regular, the hours after 8 up to 12 are overtime, and the hours
   after 12 are double time.
7. If each of the week's seven days has a shift, the seventh day, Sunday, is different: its first 8
   hours are overtime, and the rest double time.
8. All the hours of a holiday are double time, instead of rules 6 and 7.
9. The week's regular hours after the first 40 are overtime instead. Count the days in order, Monday
   first: once 40 regular hours (by rule 6) have been reached, further regular hours are overtime. Hours
   that are already overtime or double time count nothing toward the 40.

## Pay

10. Regular and call-in hours are paid at the rate, overtime at 1.5 times it, and double time at twice
    it. `"pay"` is the total, computed exactly, rounded to the cent only at the end with halves rounded
    up (32.825 is 32.83), and written with two decimal places: `Decimal("800.00")`.
'''

task(
    "shift-pay",
    "Implement weekly_pay in payroll.py so that it follows SPEC.md exactly.",
    ["python", "spec", "money"],
    {
        "SPEC.md": SPEC,
        "payroll.py": '''
            def weekly_pay(shifts, rate, holidays=()):
                """What a week of shifts pays: hours at each rate, and the pay. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_payroll.py": '''
            import unittest
            from decimal import Decimal

            from payroll import weekly_pay


            class TestBasics(unittest.TestCase):
                def test_one_shift(self):
                    result = weekly_pay([("2024-01-01 09:00", "2024-01-01 17:30")], "20")
                    self.assertEqual(result["regular"], Decimal("8"))
                    self.assertEqual(str(result["pay"]), "160.00")

                def test_end_before_start(self):
                    with self.assertRaises(ValueError):
                        weekly_pay([("2024-01-01 17:00", "2024-01-01 09:00")], "20")


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"payroll.py": open("pay_solution.py").read()},
)
