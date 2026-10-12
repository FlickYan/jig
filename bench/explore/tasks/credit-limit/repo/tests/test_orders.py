import unittest

from shop.api import post_order


class OrderTest(unittest.TestCase):
    def test_places_an_order(self):
        status, body = post_order({"customer": "c1", "items": {"flour": 2}})
        self.assertEqual((status, body["cents"]), (201, 5000))
