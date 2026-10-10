# parse_duration(text) -> int

Returns the duration in `text` as a number of seconds.

1. A duration is one or more parts, each a number followed by a unit: `1h30m`, `90s`, `2d 3h`.
2. The units are `d` (86400 seconds), `h` (3600), `m` (60) and `s` (1), in any case: `1H` is 3600.
3. Long names work too: `day`/`days`, `hour`/`hours`, `minute`/`minutes`/`min`/`mins`,
   `second`/`seconds`/`sec`/`secs`, in any case, with or without a space before them: `2 hours 5 mins`.
4. Parts may be separated by spaces, commas or the word `and`: `1h, 30m`, `1 hour and 30 minutes`.
5. A number may have a fractional part: `1.5h` is 5400. The total is rounded to the nearest whole
   second, halves rounding up: `0.5s` is 1.
6. A plain number with no unit means seconds, but only when it is the whole input: `90` is 90, while
   `1h 30` is an error.
7. Each unit may appear at most once (`1h 2h` is an error, and so is `1h 2hours`); the parts may come
   in any order: `30m1h` is 5400.
8. Leading and trailing whitespace is ignored. An empty or blank input is an error.
9. Negative numbers, a unit without a number (`h`), and anything else not described here are errors.
10. An error raises `ValueError` with a message that contains the input, in quotes.
