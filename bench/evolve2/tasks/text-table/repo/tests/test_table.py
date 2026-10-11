import unittest

from table import render


class TestBasics(unittest.TestCase):
    def test_two_columns(self):
        self.assertEqual(render([{"name": "Ada", "age": 36}, {"name": "Alan", "age": 41}]),
                         "name  age\n----  ---\nAda    36\nAlan   41\n")


if __name__ == "__main__":
    unittest.main()
