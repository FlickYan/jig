import unittest

from templates import render


class TestBasics(unittest.TestCase):
    def test_variable(self):
        self.assertEqual(render("Hello, {{ name }}!", {"name": "Ada"}), "Hello, Ada!")

    def test_escaping(self):
        self.assertEqual(render("{{ x }}", {"x": "<b>"}), "&lt;b&gt;")


if __name__ == "__main__":
    unittest.main()
