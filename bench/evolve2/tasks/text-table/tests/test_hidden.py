import unittest

from table import render


class TestSpec(unittest.TestCase):
    def check(self, cases):
        for rows, options, expected in cases:
            with self.subTest(rows=rows, options=options):
                self.assertEqual(render(rows, **options), expected)

    def test_layout_and_column_order(self):
        self.check([
            ([{'name': 'Ada', 'lang': 'en', 'score': 9.5}, {'name': 'Grace', 'score': 10, 'lang': 'en'}, {'name': '日本', 'lang': 'ja', 'score': None}], {}, 'name   lang  score\n-----  ----  -----\nAda    en     9.50\nGrace  en    10\n日本   ja\n'),
        ])

    def test_cell_text_and_alignment(self):
        self.check([
            ([{'item': 'tea', 'ok': True, 'qty': 3}, {'item': 'café', 'ok': False, 'qty': 12, 'note': 'decaf'}], {}, 'item  ok   qty  note\n----  ---  ---  -----\ntea   yes    3\ncafé  no    12  decaf\n'),
            ([{'x': 3.14159, 'n': 7, 'label': 'pi'}, {'x': 2.0, 'n': -12, 'label': 'two'}, {'x': -0.5, 'n': None, 'label': None}, {'x': 10, 'n': 0, 'label': 'ten'}], {}, '    x    n  label\n-----  ---  -----\n 3.14    7  pi\n 2.00  -12  two\n-0.50\n10       0  ten\n'),
        ])

    def test_given_columns(self):
        self.check([
            ([{'name': 'Ada', 'lang': 'en', 'score': 9.5}, {'name': 'Grace', 'score': 10, 'lang': 'en'}, {'name': '日本', 'lang': 'ja', 'score': None}], {'columns': ['score', 'name']}, 'score  name\n-----  -----\n 9.50  Ada\n10     Grace\n       日本\n'),
            ([{'name': 'Ada', 'lang': 'en', 'score': 9.5}, {'name': 'Grace', 'score': 10, 'lang': 'en'}, {'name': '日本', 'lang': 'ja', 'score': None}], {'columns': ['name', 'missing']}, 'name   missing\n-----  -------\nAda\nGrace\n日本\n'),
            ([], {'columns': ['a', 'bb']}, 'a  bb\n-  --\n'),
            ([], {}, ''),
        ])

    def test_display_width(self):
        self.check([
            ([{'k': '東京', 'v': 'x'}, {'k': 'ab', 'v': 'cafés'}, {'k': 'ｶﾀｶﾅ', 'v': 'ｱ'}], {}, 'k     v\n----  -----\n東京  x\nab    cafés\nｶﾀｶﾅ  ｱ\n'),
        ])

    def test_decimal_points_line_up(self):
        self.check([
            ([{'item': 'tea', 'qty': 3, 'price': 4.5}, {'item': 'kettle', 'qty': 1, 'price': 39.95}, {'item': 'mug', 'qty': 12, 'price': 7}], {}, 'item    qty  price\n------  ---  -----\ntea       3   4.50\nkettle    1  39.95\nmug      12   7\n'),
            ([{'n': 1}, {'n': 2.5}, {'n': None}, {'n': 10}, {'n': -0.125}], {}, '    n\n-----\n 1\n 2.50\n\n10\n-0.12\n'),
            ([{'a': 1, 'b': 2}], {}, 'a  b\n-  -\n1  2\n'),
        ])

    def test_alignment_can_be_chosen(self):
        self.check([
            ([{'item': 'tea', 'qty': 3, 'price': 4.5}, {'item': 'kettle', 'qty': 1, 'price': 39.95}, {'item': 'mug', 'qty': 12, 'price': 7}], {'align': {'item': 'center', 'qty': 'left'}}, ' item   qty  price\n------  ---  -----\n tea    3     4.50\nkettle  1    39.95\n mug    12    7\n'),
            ([{'item': 'tea', 'qty': 3, 'price': 4.5}, {'item': 'kettle', 'qty': 1, 'price': 39.95}, {'item': 'mug', 'qty': 12, 'price': 7}], {'align': {'price': 'center', 'item': 'right'}}, '  item  qty  price\n------  ---  -----\n   tea    3  4.50\nkettle    1  39.95\n   mug   12  7\n'),
            ([{'k': 'ab'}, {'k': 'abcd'}, {'k': '東'}], {'align': {'k': 'center'}}, ' k\n----\n ab\nabcd\n 東\n'),
        ])

    def test_totals(self):
        self.check([
            ([{'item': 'tea', 'qty': 3, 'price': 4.5}, {'item': 'kettle', 'qty': 1, 'price': 39.95}, {'item': 'mug', 'qty': 12, 'price': 7}], {'totals': True}, 'item    qty  price\n------  ---  -----\ntea       3   4.50\nkettle    1  39.95\nmug      12   7\n======  ===  =====\nTotal    16  51.45\n'),
            ([{'n': 1}, {'n': 2.5}, {'n': None}, {'n': 10}], {'totals': True}, '    n\n-----\n 1\n 2.50\n\n10\n=====\n13.50\n'),
            ([{'name': 'a'}], {'totals': True}, 'name\n-----\na\n=====\nTotal\n'),
            ([{'qty': 2, 'name': 'x'}, {'qty': 3, 'name': 'y'}], {'totals': True}, 'qty  name\n---  ----\n  2  x\n  3  y\n===  ====\n  5\n'),
            ([], {'columns': ['what', 'n'], 'totals': True}, 'what   n\n-----  -\n=====  =\nTotal\n'),
            ([{'item': 'tea', 'qty': 3, 'price': 4.5}, {'item': 'kettle', 'qty': 1, 'price': 39.95}, {'item': 'mug', 'qty': 12, 'price': 7}], {'totals': True, 'max_width': 16}, 'item  qty  price\n----  ---  -----\ntea     3   4.50\nket…    1  39.95\nmug    12   7\n====  ===  =====\nTot…   16  51.45\n'),
        ])

    def test_narrowing_to_fit(self):
        self.check([
            ([{'title': 'A Tale of Two Cities', 'author': 'Charles Dickens', 'year': 1859}, {'title': '東京物語の話', 'author': 'Ozu', 'year': 1953}], {'max_width': 43}, 'title                 author           year\n--------------------  ---------------  ----\nA Tale of Two Cities  Charles Dickens  1859\n東京物語の話          Ozu              1953\n'),
            ([{'title': 'A Tale of Two Cities', 'author': 'Charles Dickens', 'year': 1859}, {'title': '東京物語の話', 'author': 'Ozu', 'year': 1953}], {'max_width': 40}, 'title              author           year\n-----------------  ---------------  ----\nA Tale of Two Ci…  Charles Dickens  1859\n東京物語の話       Ozu              1953\n'),
            ([{'title': 'A Tale of Two Cities', 'author': 'Charles Dickens', 'year': 1859}, {'title': '東京物語の話', 'author': 'Ozu', 'year': 1953}], {'max_width': 35}, 'title           author         year\n--------------  -------------  ----\nA Tale of Two…  Charles Dick…  1859\n東京物語の話    Ozu            1953\n'),
            ([{'title': 'A Tale of Two Cities', 'author': 'Charles Dickens', 'year': 1859}, {'title': '東京物語の話', 'author': 'Ozu', 'year': 1953}], {'max_width': 16}, 'tit…  aut…  year\n----  ----  ----\nA T…  Cha…  1859\n東…   Ozu   1953\n'),
            ([{'name': 'Ada', 'lang': 'en', 'score': 9.5}, {'name': 'Grace', 'score': 10, 'lang': 'en'}, {'name': '日本', 'lang': 'ja', 'score': None}], {'max_width': 17}, 'name  lang  score\n----  ----  -----\nAda   en     9.50\nGra…  en    10\n日本  ja\n'),
        ])

    def test_too_narrow(self):
        for rows, width in (([{'title': 'A Tale of Two Cities', 'author': 'Charles Dickens', 'year': 1859}, {'title': '東京物語の話', 'author': 'Ozu', 'year': 1953}], 12), ([{'name': 'Ada', 'lang': 'en', 'score': 9.5}, {'name': 'Grace', 'score': 10, 'lang': 'en'}, {'name': '日本', 'lang': 'ja', 'score': None}], 14)):
            with self.subTest(width=width):
                with self.assertRaises(ValueError):
                    render(rows, max_width=width)

    def test_invalid_alignment(self):
        for align in ({"cost": "left"}, {"item": "middle"}):
            with self.subTest(align=align):
                with self.assertRaises(ValueError):
                    render([{'item': 'tea', 'qty': 3, 'price': 4.5}, {'item': 'kettle', 'qty': 1, 'price': 39.95}, {'item': 'mug', 'qty': 12, 'price': 7}], align=align)


if __name__ == "__main__":
    unittest.main()
