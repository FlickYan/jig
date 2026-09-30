import unittest

from pager import get_page, page_count, paginate


class PagerTest(unittest.TestCase):
    def test_page_count(self):
        self.assertEqual(page_count(0, 10), 1)
        self.assertEqual(page_count(10, 10), 1)
        self.assertEqual(page_count(11, 10), 2)
        self.assertEqual(page_count(25, 10), 3)

    def test_get_page(self):
        items = list(range(25))
        self.assertEqual(get_page(items, 1, 10), list(range(10)))
        self.assertEqual(get_page(items, 3, 10), [20, 21, 22, 23, 24])
        self.assertEqual(get_page(items, 4, 10), [])

    def test_paginate(self):
        body = paginate(list(range(25)), 3, 10)
        self.assertEqual(body["pages"], 3)
        self.assertEqual(body["items"], [20, 21, 22, 23, 24])
        self.assertFalse(body["has_next"])
        self.assertTrue(paginate(list(range(25)), 2, 10)["has_next"])

    def test_errors(self):
        with self.assertRaises(ValueError):
            get_page([1], 0, 10)
        with self.assertRaises(ValueError):
            page_count(5, 0)


if __name__ == "__main__":
    unittest.main()
