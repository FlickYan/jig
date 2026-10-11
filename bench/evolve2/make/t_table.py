import importlib.util
from maketask import task

spec = importlib.util.spec_from_file_location("t", "table_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
PEOPLE = [{"name": "Ada", "lang": "en", "score": 9.5}, {"name": "Grace", "score": 10, "lang": "en"}, {"name": "日本", "lang": "ja", "score": None}]
ITEMS = [{"item": "tea", "ok": True, "qty": 3}, {"item": "café", "ok": False, "qty": 12, "note": "decaf"}]
BOOKS = [{"title": "A Tale of Two Cities", "author": "Charles Dickens", "year": 1859}, {"title": "東京物語の話", "author": "Ozu", "year": 1953}]
NUMBERS = [{"x": 3.14159, "n": 7, "label": "pi"}, {"x": 2.0, "n": -12, "label": "two"}, {"x": -0.5, "n": None, "label": None}, {"x": 10, "n": 0, "label": "ten"}]
SALES = [{"item": "tea", "qty": 3, "price": 4.5}, {"item": "kettle", "qty": 1, "price": 39.95}, {"item": "mug", "qty": 12, "price": 7}]
CASES = {
    "test_layout_and_column_order": [(PEOPLE, {})],
    "test_cell_text_and_alignment": [(ITEMS, {}), (NUMBERS, {})],
    "test_given_columns": [(PEOPLE, {"columns": ["score", "name"]}), (PEOPLE, {"columns": ["name", "missing"]}), ([], {"columns": ["a", "bb"]}), ([], {})],
    "test_display_width": [([{"k": "東京", "v": "x"}, {"k": "ab", "v": "cafés"}, {"k": "ｶﾀｶﾅ", "v": "ｱ"}], {})],
    "test_decimal_points_line_up": [(SALES, {}), ([{"n": 1}, {"n": 2.5}, {"n": None}, {"n": 10}, {"n": -0.125}], {}), ([{"a": 1, "b": 2}], {})],
    "test_alignment_can_be_chosen": [(SALES, {"align": {"item": "center", "qty": "left"}}), (SALES, {"align": {"price": "center", "item": "right"}}), ([{"k": "ab"}, {"k": "abcd"}, {"k": "東"}], {"align": {"k": "center"}})],
    "test_totals": [(SALES, {"totals": True}), ([{"n": 1}, {"n": 2.5}, {"n": None}, {"n": 10}], {"totals": True}), ([{"name": "a"}], {"totals": True}),
                    ([{"qty": 2, "name": "x"}, {"qty": 3, "name": "y"}], {"totals": True}), ([], {"columns": ["what", "n"], "totals": True}),
                    (SALES, {"totals": True, "max_width": 16})],
    "test_narrowing_to_fit": [(BOOKS, {"max_width": 43}), (BOOKS, {"max_width": 40}), (BOOKS, {"max_width": 35}), (BOOKS, {"max_width": 16}), (PEOPLE, {"max_width": 17})],
}
for rows, kwargs in [(BOOKS, {"max_width": 12}), (PEOPLE, {"max_width": 14}), (SALES, {"align": {"cost": "left"}}), (SALES, {"align": {"item": "middle"}})]:
    try:
        m.render(rows, **kwargs); raise SystemExit(f"fitted {kwargs}")
    except ValueError:
        pass

methods = []
for method, cases in CASES.items():
    body = "\n".join(f"            ({rows!r}, {kwargs!r}, {m.render(rows, **kwargs)!r})," for rows, kwargs in cases)
    methods.append(f"    def {method}(self):\n        self.check([\n{body}\n        ])\n")

hidden = '''
import unittest

from table import render


class TestSpec(unittest.TestCase):
    def check(self, cases):
        for rows, options, expected in cases:
            with self.subTest(rows=rows, options=options):
                self.assertEqual(render(rows, **options), expected)

''' + "\n".join(methods) + f'''
    def test_too_narrow(self):
        for rows, width in (({BOOKS!r}, 12), ({PEOPLE!r}, 14)):
            with self.subTest(width=width):
                with self.assertRaises(ValueError):
                    render(rows, max_width=width)

    def test_invalid_alignment(self):
        for align in ({{"cost": "left"}}, {{"item": "middle"}}):
            with self.subTest(align=align):
                with self.assertRaises(ValueError):
                    render({SALES!r}, align=align)


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
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
'''

task(
    "text-table",
    "Implement render in table.py so that it follows SPEC.md exactly.",
    ["python", "spec", "text"],
    {
        "SPEC.md": SPEC,
        "table.py": '''
            def render(rows, columns=None, max_width=None, align=None, totals=False):
                """A text table for a list of dicts. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_table.py": '''
            import unittest

            from table import render


            class TestBasics(unittest.TestCase):
                def test_two_columns(self):
                    self.assertEqual(render([{"name": "Ada", "age": 36}, {"name": "Alan", "age": 41}]),
                                     "name  age\\n----  ---\\nAda    36\\nAlan   41\\n")


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"table.py": open("table_solution.py").read()},
)
