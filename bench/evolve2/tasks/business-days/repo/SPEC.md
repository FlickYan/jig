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
