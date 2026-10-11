# loads(text) -> dict

Parses a TOML document into a dict, for the part of TOML 1.0 described here. Anything that isn't valid
raises `TOMLError` (defined in `toml_lite.py`, a subclass of `ValueError`). Write the parser yourself: the
tests don't let it use `tomllib` or any other TOML library.

## Lines, comments and keys

1. A `#` outside a string starts a comment, which runs to the end of the line. Whitespace is spaces and
   tabs. Lines end with `\n` or `\r\n` (a `\r` on its own is invalid).
2. A key/value pair is `key = value`, with optional whitespace around the `=`; the value may run over
   several lines only if it is a multi-line string or an array. After the value, only whitespace and a
   comment may follow on its last line.
3. A key is bare (one or more of `A-Z`, `a-z`, `0-9`, `_` and `-`), or a basic or literal string (rule
   6), which may be empty: `""`. A quoted key and a bare key with the same text are the same key. A
   dotted key `a.b.c` (whitespace around the dots is allowed) puts the value in nested tables, creating
   the tables it needs.
4. A header `[name]`, on a line of its own (whitespace and a comment may follow), starts a table: the
   key/value pairs after it, up to the next header, go in it. The name is a key as in rule 3 (dotted for
   nested tables, with whitespace allowed inside the brackets) and a path from the root. `[[name]]`
   appends a new table to the array of tables of that name, creating the array the first time, and the
   pairs after it go in that new table. In a header, a name that is an array of tables refers to its
   last table: `[fruit.variety]` after `[[fruit]]` is a table in the last fruit.

## Values

5. Booleans: `true` and `false`.
6. Basic strings, in double quotes, with the escapes `\b`, `\t`, `\n`, `\f`, `\r`, `\"`, `\\`, `\uXXXX`
   and `\UXXXXXXXX` (hexadecimal digits for a Unicode scalar value, so not a surrogate); any other
   backslash is invalid. Literal strings, in single quotes, with no escapes at all: what is between the
   quotes is the string. Neither kind may contain a newline.
7. Multi-line basic strings, in three double quotes, may span lines; a newline right after the opening
   quotes is left out. They have the escapes of basic strings, and one more: a backslash at the end of a
   line (with only spaces or tabs after it on the line) removes the newline and all the spaces, tabs and
   newlines after it, up to the next other character. One or two `"` in a row may appear anywhere in the
   string, even just before the closing quotes (so five quotes end a string that ends with `""`), but
   never three. Multi-line literal strings, in three single quotes, are the same without any escapes, and
   with up to two `'` in a row. Multi-line strings are values, never keys, and their newlines come out as
   `\n`.
8. Integers: decimal, with an optional `+` or `-` and no leading zeros (`0`, `+0` and `-0` are fine,
   `012` is not); or hexadecimal `0x`, octal `0o` and binary `0b`, with no sign, and hexadecimal digits
   in either case. An underscore may stand between two digits (`1_000`, `0xdead_beef`), and nowhere
   else.
9. Floats: an integer part (decimal, as in rule 8, sign allowed) followed by a fractional part (`.` and
   digits), an exponent (`e` or `E`, an optional sign, and digits, which may have leading zeros), or
   both: `3.14`, `-0.01`, `5e+22`, `1e06`, `6.626e-34`. Each part needs digits: `.5`, `5.` and `5.e3` are
   invalid. Underscores as in rule 8. Also `inf` and `nan`, with an optional sign.
10. Arrays: values separated by commas, in `[` and `]`. An array may span lines, hold comments, end with
    a trailing comma, and mix types: `[1, "two", [3]]`.
11. Inline tables: `{ key = value, ... }` on one line, with keys as in rule 3 (dotted ones too) and no
    trailing comma; `{}` is empty.
12. Dates and times, as in RFC 3339: `1979-05-27T07:32:00Z` (or with an offset, `-07:00`, `+05:30`) is a
    `datetime.datetime` with that time zone (a `datetime.timezone`; `Z` is UTC); without the offset,
    `1979-05-27T07:32:00` is a `datetime.datetime` without one; `1979-05-27` is a `datetime.date`, and
    `07:32:00` a `datetime.time`. The `T` may also be a `t` or a space, and the `Z` a `z`. A date is
    `YYYY-MM-DD` and a time `HH:MM:SS`, two digits each part (four for the year), and a time may have a
    fraction of a second, `.` and digits, of which only the first six (microseconds) count. An offset is
    `+` or `-` and `HH:MM`. Each must be a real date and time: a month from 01 to 12 and a day it has,
    hours from 00 to 23, minutes and seconds from 00 to 59.

Integers come out as `int`, floats as `float`, booleans as `bool`, strings as `str`, arrays as `list` and
tables as `dict`.

## What can be defined only once

13. A key can be given a value only once, and a key that holds a value isn't a table: no dotted key or
    header can go through it.
14. A header can define a table only once, and can't name a key that holds a value. A table that headers
    have only passed through (`a`, in `[a.b]`) can still get its own header later, once.
15. A table created by a dotted key can't get a header of its own later (`[a]` after `a.b = 1` is
    invalid), but a header may define a new table inside it (`[a.c]` after `a.b = 1` is fine).
16. A dotted key can't add to a table that a header defined: after `[a.b]`, a `b.c = 1` under `[a]` is
    invalid. (It can add to a table that headers have only passed through.)
17. Inline tables and arrays are complete as written: nothing can be added to them later, by a dotted
    key, a header or `[[...]]`.
18. `[name]` can't follow `[[name]]`, and `[[name]]` can't follow `[name]`.
