# next_run(expression, after) -> datetime

The first time strictly after `after` (a naive `datetime`) at which a cron expression fires.

1. An expression has five fields separated by whitespace: minute (0-59), hour (0-23), day of month
   (1-31), month (1-12) and day of week (0-7).
2. A field is `*`, a number, a range `a-b`, a step `*/n` or `a-b/n` (every n-th value of the range,
   starting from its first), or a comma-separated list of any of these: `1,15,30-40/5`.
3. Months may also be written `JAN` to `DEC`, and days of the week `SUN` to `SAT`, in any case, also
   in ranges: `MON-FRI`.
4. In the day-of-week field, 0 and 7 both mean Sunday.
5. If both the day of month and the day of week are restricted (neither is `*`), a day matches when
   EITHER matches: `0 9 1 * MON` fires at 9:00 on the first of every month and on every Monday. If
   only one of them is restricted, only that one counts.
6. The result has seconds and microseconds of zero, and is strictly later than `after`: an `after`
   that is itself a matching minute, with seconds of zero, does not count.
7. A malformed expression (the wrong number of fields, a value out of range, a step of 0, a range
   that goes backwards, an unknown name) raises `ValueError`.
8. An expression that never fires (like `0 0 30 2 *`, the 30th of February) raises `ValueError`; it
   must not loop forever. Looking five years ahead is enough to be sure.
