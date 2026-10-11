import unittest
from decimal import Decimal

from payroll import weekly_pay


class TestBasics(unittest.TestCase):
    def test_one_shift(self):
        result = weekly_pay([("2024-01-01 09:00", "2024-01-01 17:30")], "20")
        self.assertEqual(result["regular"], Decimal("8"))
        self.assertEqual(str(result["pay"]), "160.00")

    def test_end_before_start(self):
        with self.assertRaises(ValueError):
            weekly_pay([("2024-01-01 17:00", "2024-01-01 09:00")], "20")


if __name__ == "__main__":
    unittest.main()
