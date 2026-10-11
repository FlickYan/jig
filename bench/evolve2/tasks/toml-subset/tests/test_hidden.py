import datetime
import math
import sys
import unittest

# The parser is to be written, not borrowed.
sys.modules["tomllib"] = None
sys.modules["tomli"] = None

from toml_lite import TOMLError, loads  # noqa: E402


def typed(value):
    """The value with every leaf's type, since 1 == 1.0 == True in Python."""
    if isinstance(value, dict):
        return {key: typed(item) for key, item in value.items()}
    if isinstance(value, list):
        return [typed(item) for item in value]
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return (type(value).__name__, value.isoformat())  # with its offset, which == ignores
    return (type(value).__name__, value)


class TestSpec(unittest.TestCase):
    """Every expectation here is what Python's tomllib makes of the same document."""

    def valid(self, cases):
        for name, document, expected in cases:
            with self.subTest(name, document=document):
                self.assertEqual(typed(loads(document)), typed(expected))

    def invalid(self, cases):
        for name, document in cases:
            with self.subTest(name, document=document):
                with self.assertRaises(TOMLError):
                    loads(document)

    def test_comments_keys_and_whitespace(self):
        self.valid([
            ('comments and blank lines', "# a comment\n\ntitle = 'x' # after a value\n\n", {'title': 'x'}),
            ('crlf', "a = 1\r\nb = 'two'\r\n", {'a': 1, 'b': 'two'}),
            ('bare and quoted keys', 'bare_key-1 = 1\n1234 = 2\n"quoted key" = 3\n\'literal.key\' = 4\n"" = 5\n', {'bare_key-1': 1, '1234': 2, 'quoted key': 3, 'literal.key': 4, '': 5}),
            ('dotted keys', 'site.name = "x"\nsite . owner . id = 7\n"a.b".c = true\n', {'site': {'name': 'x', 'owner': {'id': 7}}, 'a.b': {'c': True}}),
            ('whitespace', 'a\t=\t1\n  b = 2  \n\t[t]\n\tc = 3\n', {'a': 1, 'b': 2, 't': {'c': 3}}),
            ('empty document', '', {}),
            ('only comments', '# nothing\n   # at all\n', {}),
        ])

    def test_tables(self):
        self.valid([
            ('tables', "[server]\nhost = 'localhost'\nport = 8080\n\n[server.tls]\nenabled = false\n", {'server': {'host': 'localhost', 'port': 8080, 'tls': {'enabled': False}}}),
            ('header spaces and quotes', '[ a . "b.c" ]\nd = 1\n', {'a': {'b.c': {'d': 1}}}),
            ('super table after sub', '[a.b]\nc = 1\n[a]\nd = 2\n', {'a': {'b': {'c': 1}, 'd': 2}}),
            ('header inside dotted table', 'a.b = 1\n[a.c]\nd = 2\n', {'a': {'b': 1, 'c': {'d': 2}}}),
            ('dotted after header prefix', '[a.b.c]\nx = 1\n[a]\nb.d = 1\n', {'a': {'b': {'c': {'x': 1}, 'd': 1}}}),
            ('dotted inside a section', "[owner]\nname.first = 'Ada'\nname.last = 'Lovelace'\n", {'owner': {'name': {'first': 'Ada', 'last': 'Lovelace'}}}),
        ])

    def test_arrays_of_tables(self):
        self.valid([
            ('array of tables', "[[product]]\nname = 'hammer'\n\n[[product]]\n\n[[product]]\nname = 'nail'\n", {'product': [{'name': 'hammer'}, {}, {'name': 'nail'}]}),
            ('array of tables with subtables', "[[fruit]]\nname = 'apple'\n[fruit.physical]\ncolor = 'red'\n[[fruit.variety]]\nname = 'fuji'\n[[fruit.variety]]\nname = 'gala'\n[[fruit]]\nname = 'banana'\n", {'fruit': [{'name': 'apple', 'physical': {'color': 'red'}, 'variety': [{'name': 'fuji'}, {'name': 'gala'}]}, {'name': 'banana'}]}),
        ])

    def test_strings_and_booleans(self):
        self.valid([
            ('booleans', 'a = true\nb = false\n', {'a': True, 'b': False}),
            ('basic string escapes', 'a = "tab\\there, quote \\" backslash \\\\ nl\\n"\nb = "\\u00e9 \\U0001F600 \\b\\f\\r"\n', {'a': 'tab\there, quote " backslash \\ nl\n', 'b': 'é 😀 \x08\x0c\r'}),
            ('literal strings', 'path = \'C:\\Users\\nobody\'\nre = \'<\\i\\c*\\s*>\'\nquote = \'say "hi"\'\n', {'path': 'C:\\Users\\nobody', 're': '<\\i\\c*\\s*>', 'quote': 'say "hi"'}),
        ])

    def test_numbers(self):
        self.valid([
            ('integers', 'a = 99\nb = +17\nc = -5\nd = 0\ne = +0\nf = -0\ng = 1_000_000\nh = 5_349_221\n', {'a': 99, 'b': 17, 'c': -5, 'd': 0, 'e': 0, 'f': 0, 'g': 1000000, 'h': 5349221}),
            ('prefixed integers', 'hex = 0xDEADbeef\nhex2 = 0xdead_beef\noct = 0o755\nbin = 0b1101_0110\nzero = 0x0\n', {'hex': 3735928559, 'hex2': 3735928559, 'oct': 493, 'bin': 214, 'zero': 0}),
            ('floats', 'a = 3.1415\nb = -0.01\nc = 5e+22\nd = 1e06\ne = -2E-2\nf = 6.626e-34\ng = 224_617.445_991\nh = -0.0\ni = +1.5\n', {'a': 3.1415, 'b': -0.01, 'c': 5e+22, 'd': 1000000.0, 'e': -0.02, 'f': 6.626e-34, 'g': 224617.445991, 'h': -0.0, 'i': 1.5}),
            ('inf and nan', 'a = inf\nb = +inf\nc = -inf\n', {'a': float('inf'), 'b': float('inf'), 'c': float('-inf')}),
        ])

    def test_arrays_and_inline_tables(self):
        self.valid([
            ('arrays', 'a = [1, 2, 3]\nb = [\'x\', "y"]\nc = [[1, 2], [\'a\']]\nd = []\ne = [1, \'two\', 3.0, true, [], {}]\n', {'a': [1, 2, 3], 'b': ['x', 'y'], 'c': [[1, 2], ['a']], 'd': [], 'e': [1, 'two', 3.0, True, [], {}]}),
            ('multi-line array', 'a = [\n  1, # one\n  2,\n\n  3, # trailing comma\n]\nb = [ # starts here\n]\n', {'a': [1, 2, 3], 'b': []}),
            ('inline tables', 'point = { x = 1, y = 2 }\nempty = {}\nnested = { a = { b = 1 }, c.d = 2 }\ninarray = [ { n = 1 }, { n = 2 } ]\n', {'point': {'x': 1, 'y': 2}, 'empty': {}, 'nested': {'a': {'b': 1}, 'c': {'d': 2}}, 'inarray': [{'n': 1}, {'n': 2}]}),
        ])

    def test_multi_line_strings(self):
        self.valid([
            ('ml basic', 'a = """\nline one\nline two"""\nb = """x\ny"""\n', {'a': 'line one\nline two', 'b': 'x\ny'}),
            ('ml line-ending backslash', 'a = """\\\n   The quick \\\n\n   brown fox."""\nb = """a \\   \n   b"""\n', {'a': 'The quick brown fox.', 'b': 'a b'}),
            ('ml quotes', 'a = """She said "hi" and ""bye""."""\nb = """"This," she said, "is pointless.""""\nc = """x""""\nd = """x"""""\n', {'a': 'She said "hi" and ""bye"".', 'b': '"This," she said, "is pointless."', 'c': 'x"', 'd': 'x""'}),
            ('ml escapes', 'a = """tab\\t uni\\u00e9 quote\\" back\\\\"""\n', {'a': 'tab\t unié quote" back\\'}),
            ('ml literal', "a = '''\nC:\\\\path\\n kept '' two'''\nb = ''''That's it,' she said.''''\nc = '''x''''\n", {'a': "C:\\\\path\\n kept '' two", 'b': "'That's it,' she said.'", 'c': "x'"}),
            ('ml crlf and arrays', 'a = """\r\nx\r\ny"""\r\nb = ["""p\nq""", \'\'\'r\'\'\']\r\n', {'a': 'x\ny', 'b': ['p\nq', 'r']}),
        ])

    def test_dates_and_times(self):
        self.valid([
            ('offset date-times', 'a = 1979-05-27T07:32:00Z\nb = 1979-05-27T00:32:00-07:00\nc = 1979-05-27T00:32:00.999999+05:30\nd = 1979-05-27 07:32:00z\ne = 1979-05-27t07:32:00+00:00\n', {'a': datetime.datetime(1979, 5, 27, 7, 32, tzinfo=datetime.timezone.utc), 'b': datetime.datetime(1979, 5, 27, 0, 32, tzinfo=datetime.timezone(datetime.timedelta(days=-1, seconds=61200))), 'c': datetime.datetime(1979, 5, 27, 0, 32, 0, 999999, tzinfo=datetime.timezone(datetime.timedelta(seconds=19800))), 'd': datetime.datetime(1979, 5, 27, 7, 32, tzinfo=datetime.timezone.utc), 'e': datetime.datetime(1979, 5, 27, 7, 32, tzinfo=datetime.timezone.utc)}),
            ('local date-times, dates and times', 'a = 1979-05-27T07:32:00\nb = 1979-05-27T00:32:00.5\nc = 1979-05-27\nd = 07:32:00\ne = 00:32:00.123456789\nf = 2024-02-29\n', {'a': datetime.datetime(1979, 5, 27, 7, 32), 'b': datetime.datetime(1979, 5, 27, 0, 32, 0, 500000), 'c': datetime.date(1979, 5, 27), 'd': datetime.time(7, 32), 'e': datetime.time(0, 32, 0, 123456), 'f': datetime.date(2024, 2, 29)}),
            ('dates in arrays and tables', 'a = [1979-05-27, 07:32:00] # comment\nb = {when = 1979-05-27T07:32:00Z}\nc = 1979-05-27 # birthday\n', {'a': [datetime.date(1979, 5, 27), datetime.time(7, 32)], 'b': {'when': datetime.datetime(1979, 5, 27, 7, 32, tzinfo=datetime.timezone.utc)}, 'c': datetime.date(1979, 5, 27)}),
        ])

    def test_invalid_lines_and_keys(self):
        self.invalid([
            ('two pairs on a line', 'a = 1 b = 2\n'),
            ('value missing', 'a =\n'),
            ('empty bare key', '= 1\n'),
            ('key without value', 'a\n'),
            ('unclosed header', '[a\nb = 1\n'),
            ('text after header', '[a] b = 1\n'),
            ('lone carriage return', 'a = 1\rb = 2\n'),
            ('newline in a key', '"a\nb" = 1\n'),
        ])

    def test_defined_only_once(self):
        self.invalid([
            ('duplicate key', 'a = 1\na = 2\n'),
            ('duplicate key, quoted', 'a = 1\n"a" = 2\n'),
            ('duplicate dotted key', 'a.b = 1\na.b = 2\n'),
            ('dotted key through a value', 'a = 1\na.b = 2\n'),
            ('duplicate key in inline table', 'a = {b = 1, b = 2}\n'),
            ('table twice', '[a]\nx = 1\n[a]\ny = 2\n'),
            ('implicit table defined twice', '[a.b]\n[a]\n[a]\n'),
            ('header over a value', 'a = 1\n[a]\n'),
            ('header under a value', '[a]\nb = 1\n[a.b.c]\n'),
        ])

    def test_dotted_tables_and_header_tables_stay_apart(self):
        self.invalid([
            ('header for a dotted table', 'a.b = 1\n[a]\nc = 2\n'),
            ('dotted key into a header table', '[a.b]\nc = 1\n[a]\nb.d = 2\n'),
        ])

    def test_inline_tables_and_arrays_are_complete(self):
        self.invalid([
            ('inline table extended by a dotted key', 'a = {b = 1}\na.c = 2\n'),
            ('inline table extended by a header', 'a = {b = 1}\n[a.c]\n'),
            ('inline table given a header', 'a = {b = 1}\n[a]\n'),
            ('array extended by [[ ]]', 'a = []\n[[a]]\n'),
            ('table after array of tables', '[[a]]\n[a]\n'),
            ('array of tables after table', '[a]\n[[a]]\n'),
        ])

    def test_invalid_values(self):
        self.invalid([
            ('trailing comma in inline table', 'a = {b = 1,}\n'),
            ('newline in inline table', 'a = {b = 1,\nc = 2}\n'),
            ('comment in inline table', 'a = {b = 1 # no\n}\n'),
            ('array without comma', 'a = [1 2]\n'),
            ('unclosed array', 'a = [1, 2\n'),
            ('capitalized boolean', 'a = True\n'),
            ('unknown escape', 'a = "\\x41"\n'),
            ('short unicode escape', 'a = "\\u12"\n'),
            ('surrogate escape', 'a = "\\uD800"\n'),
            ('unclosed basic string', 'a = "abc\n'),
            ('unclosed literal string', "a = 'abc\n"),
        ])

    def test_invalid_multi_line_strings(self):
        self.invalid([
            ('six quotes', 'a = """x""""""\n'),
            ('bad escape in ml', 'a = """\\x"""\n'),
            ('unclosed ml', 'a = """abc\n'),
            ('ml key', '"""a""" = 1\n'),
            ('unclosed ml literal', "a = '''abc\n"),
            ('backslash space x', 'a = """\\ x"""\n'),
        ])

    def test_invalid_dates_and_times(self):
        self.invalid([
            ('time without seconds', 'a = 07:32\n'),
            ('month 13', 'a = 1979-13-27\n'),
            ('february 29', 'a = 2023-02-29\n'),
            ('hour 24', 'a = 24:00:00\n'),
            ('single-digit month', 'a = 1979-5-27\n'),
            ('date then word', 'a = 1979-05-27 x\n'),
            ('offset without colon', 'a = 1979-05-27T07:32:00+0700\n'),
            ('second 60', 'a = 1979-05-27T23:59:60Z\n'),
            ('minute 60', 'a = 12:60:00\n'),
            ('offset hour 24', 'a = 1979-05-27T07:32:00+24:00\n'),
        ])

    def test_invalid_numbers(self):
        self.invalid([
            ('leading zero', 'a = 012\n'),
            ('signed hex', 'a = +0x1\n'),
            ('double underscore', 'a = 1__000\n'),
            ('trailing underscore', 'a = 10_\n'),
            ('leading underscore', 'a = _10\n'),
            ('underscore before point', 'a = 1_.5\n'),
            ('bad hex digit', 'a = 0xG1\n'),
            ('bad octal digit', 'a = 0o8\n'),
            ('float starting with a point', 'a = .5\n'),
            ('float ending with a point', 'a = 5.\n'),
            ('point before exponent', 'a = 5.e3\n'),
            ('exponent without digits', 'a = 1e\n'),
        ])

    def test_nan(self):
        for text in ("a = nan\n", "a = +nan\n", "a = -nan\n"):
            value = loads(text)["a"]
            self.assertIsInstance(value, float)
            self.assertTrue(math.isnan(value), text)

    def test_error_is_a_value_error(self):
        self.assertTrue(issubclass(TOMLError, ValueError))


if __name__ == "__main__":
    unittest.main()
