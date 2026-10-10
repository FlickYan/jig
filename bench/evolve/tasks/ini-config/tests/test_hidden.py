import unittest

from iniconfig import parse


class TestSpec(unittest.TestCase):
    def test_case_and_default_section(self):
        self.assertEqual(parse("Name = top\n[ Server ]\nHOST = h\n"), {"default": {"name": "top"}, "server": {"host": "h"}})

    def test_inline_comments(self):
        self.assertEqual(parse("[a]\nx = 1 # one\ny = 2 ; two\nz = a#b\n"), {"a": {"x": "1", "y": "2", "z": "a#b"}})
        self.assertEqual(parse("  ; indented comment\n[a]\nx=1"), {"a": {"x": "1"}})

    def test_quotes(self):
        result = parse('[a]\nx = "  spaced # not a comment ; either  "\ny = "say \\"hi\\" \\\\ done"\n')
        self.assertEqual(result["a"]["x"], "  spaced # not a comment ; either  ")
        self.assertEqual(result["a"]["y"], 'say "hi" \\ done')

    def test_continuation(self):
        self.assertEqual(parse("[a]\nx = one\n  two\n\tthree\ny = 4\n"), {"a": {"x": "one two three", "y": "4"}})
        with self.assertRaises(ValueError):
            parse("[a]\nx = one\n\n  two\n")

    def test_duplicates(self):
        self.assertEqual(parse("[a]\nx = 1\nx = 2\n[b]\ny=1\n[A]\nz = 3\n"), {"a": {"x": "2", "z": "3"}, "b": {"y": "1"}})

    def test_empty_value(self):
        self.assertEqual(parse("[a]\nx =\ny:\n"), {"a": {"x": "", "y": ""}})

    def test_interpolation(self):
        text = "[paths]\nhome = /srv\nlogs = ${home}/logs\n[app]\nlog = ${paths:logs}/app.log\nfirst = ${second}\nsecond = 2\n"
        result = parse(text)
        self.assertEqual(result["paths"]["logs"], "/srv/logs")
        self.assertEqual(result["app"]["log"], "/srv/logs/app.log")
        self.assertEqual(result["app"]["first"], "2")
        for bad in ["[a]\nx = ${missing}\n", "[a]\nx = ${b:y}\n", "[a]\nx = ${y}\ny = ${x}\n", "[a]\nx = ${x}\n"]:
            with self.assertRaises(ValueError, msg=bad):
                parse(bad)

    def test_bad_lines_name_their_number(self):
        with self.assertRaises(ValueError) as caught:
            parse("[a]\nx = 1\nthis is not valid\n")
        self.assertIn("3", str(caught.exception))
        for bad in ["[unclosed\n", "  leading continuation\n", "= value\n"]:
            with self.assertRaises(ValueError, msg=bad):
                parse(bad)


if __name__ == "__main__":
    unittest.main()
