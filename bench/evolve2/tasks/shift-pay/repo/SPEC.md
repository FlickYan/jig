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
