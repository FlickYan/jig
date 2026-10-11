import unittest

from league import standings


class TestBasics(unittest.TestCase):
    def test_two_teams(self):
        self.assertEqual([tuple(row) for row in standings(["Ajax 2-1 Benfica"])], [
            (1, "Ajax", 1, 1, 0, 0, 2, 1, 1, 3),
            (2, "Benfica", 1, 0, 0, 1, 1, 2, -1, 0),
        ])

    def test_invalid(self):
        with self.assertRaises(ValueError):
            standings(["Ajax beat Benfica"])


if __name__ == "__main__":
    unittest.main()
