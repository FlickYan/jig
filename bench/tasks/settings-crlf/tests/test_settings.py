import unittest

from settings import parse_settings


class SettingsTest(unittest.TestCase):
    def test_equals_sign_in_value(self):
        text = "url = postgres://db/app?sslmode=require&pool=5\n"
        self.assertEqual(parse_settings(text)["url"], "postgres://db/app?sslmode=require&pool=5")

    def test_comments_and_blank_lines(self):
        self.assertEqual(parse_settings("# comment\n\na = 1\nb=2\n"), {"a": "1", "b": "2"})

    def test_empty_value(self):
        self.assertEqual(parse_settings("key =\n")["key"], "")

    def test_line_without_equals_sign(self):
        with self.assertRaisesRegex(ValueError, r"^line 3: expected key = value$"):
            parse_settings("a = 1\n\nnot a setting\n")

    def test_windows_input(self):
        self.assertEqual(parse_settings("a = 1\r\nb = x=y\r\n"), {"a": "1", "b": "x=y"})

    def test_file_still_uses_crlf(self):
        with open("settings.py", "rb") as f:
            raw = f.read()
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""), "every line should still end with CRLF")


if __name__ == "__main__":
    unittest.main()
