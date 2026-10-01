import ast
import unittest

from csvlite import parse_csv


class ParseCsvTest(unittest.TestCase):
    def test_plain_records(self):
        self.assertEqual(parse_csv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]])
        self.assertEqual(parse_csv("a,b"), [["a", "b"]])
        self.assertEqual(parse_csv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]])
        self.assertEqual(parse_csv(""), [])

    def test_quoted_fields(self):
        self.assertEqual(parse_csv('x,"a,b",y'), [["x", "a,b", "y"]])
        self.assertEqual(parse_csv('"say ""hi"""'), [['say "hi"']])
        self.assertEqual(parse_csv('"",x'), [["", "x"]])

    def test_newlines_inside_quotes(self):
        self.assertEqual(parse_csv('"line 1\nline 2",z\nnext'), [["line 1\nline 2", "z"], ["next"]])
        self.assertEqual(parse_csv('"a\r\nb"\r\n'), [["a\r\nb"]])

    def test_empty_fields_blank_lines_and_spaces(self):
        self.assertEqual(parse_csv(",a,,\n"), [["", "a", "", ""]])
        self.assertEqual(parse_csv("a\n\nb\n"), [["a"], ["b"]])
        self.assertEqual(parse_csv(" a , b "), [[" a ", " b "]])

    def test_quote_in_an_unquoted_field_is_ordinary(self):
        self.assertEqual(parse_csv('a"b,c'), [['a"b', "c"]])

    def test_errors_name_the_line(self):
        with self.assertRaisesRegex(ValueError, r"^unterminated quote on line 2$"):
            parse_csv('ok\nx,"never\nclosed')
        with self.assertRaisesRegex(ValueError, r"^unexpected character after quote on line 1$"):
            parse_csv('"a"b,c')
        with self.assertRaisesRegex(ValueError, r"^unexpected character after quote on line 3$"):
            parse_csv('a\n"two\nlines"x')

    def test_does_not_use_the_csv_module(self):
        with open("csvlite.py") as f:
            tree = ast.parse(f.read())
        imported = [alias.name for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names]
        imported += [node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
        self.assertNotIn("csv", imported)


if __name__ == "__main__":
    unittest.main()
