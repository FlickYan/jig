import unittest

from billing.split import proportional_shares


class ProportionalSharesTest(unittest.TestCase):
    def test_shares_add_up(self):
        self.assertEqual(proportional_shares(1000, [1, 1, 1]), [334, 333, 333])
        self.assertEqual(proportional_shares(100, [3, 1]), [75, 25])
