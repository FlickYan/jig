import unittest

from greet import greeting


class GreetTest(unittest.TestCase):
    def test_has_the_name(self):
        self.assertIn("Ada", greeting("Ada"))
