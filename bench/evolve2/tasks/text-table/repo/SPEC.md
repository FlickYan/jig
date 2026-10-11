# render(rows, columns=None, max_width=None, align=None, totals=False) -> str

A text table for a list of dicts, one row per dict.

## Cells and columns

1. The columns are `columns` if it is given (only those, in that order), or else every key of the rows,
   in the order they first appear (row by row, and key by key within a row). A column that a row hasn't
   got is an empty cell in that row. With no columns at all, the result is `""`.
2. A numeric column is one with at least one value, all of them ints or floats, not counting empty cells
   (booleans aren't numbers here).
3. A cell's text: `None` is empty, `True` and `False` are `yes` and `no`, a float is written with two
   decimals (`format(value, ".2f")`), and anything else is `str(value)`, except that in a numeric column
   with a float in it, an int is followed by three spaces, where a float has its point and decimals, so
   that the points line up (`10` is `10   `). A header is the column's name.
4. Text is measured in display columns: a character is 2 columns wide if
   `unicodedata.east_asian_width` gives `"W"` or `"F"` for it, 0 if `unicodedata.combining` gives
   anything but 0, and 1 otherwise.
5. A column is as wide as the widest of its header and its cells (the totals' too, rule 8).
6. A numeric column's header and cells are aligned right, and every other column's left, unless `align`
   says otherwise: it maps column names to `"left"`, `"right"` or `"center"`. A centred text has half its
   padding on each side, and the odd space on the right. A name that isn't a column of the table, or any
   other alignment, raises `ValueError`. Cells are padded with spaces to the column's width.

## Lines

7. The table is the header line, a line of `-`s as wide as each column, and a line for each row, in
   order, every line ending in `\n`. On a line, the cells are separated by two spaces, and spaces at the
   end of the line are removed.
8. With `totals=True`, two more lines follow: a line of `=`s as wide as each column, and a totals line.
   Its cell in each numeric column is the sum of the column's values, written as a cell of that column
   (rule 3; a float if the column has a float); its first cell, unless the first column is numeric, is
   `Total`; and its other cells are empty.

## Fitting a width

9. With `max_width`, a table wider than it (its width is the columns' widths plus two for each space
   between columns) is narrowed: one column at a time loses one column of width, until the table fits.
   The column narrowed each time is the widest of those that may still be narrowed (numeric columns may
   not, and no column goes below 3), and of those equally wide, the rightmost. If no column can be
   narrowed and the table still doesn't fit, `ValueError` is raised.
10. A cell or header wider than its column is cut: it keeps the longest start of its text that is at
    most the column's width less one, followed by `…` (one column wide).
