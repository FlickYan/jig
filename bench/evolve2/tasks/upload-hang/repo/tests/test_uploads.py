import unittest

from uploads.handler import handle_upload
from uploads.store import Store


class TestUploads(unittest.TestCase):
    def test_accepted_and_listed(self):
        store = Store()
        self.assertEqual(handle_upload(store, {"name": "notes.txt", "size": 10, "owner": "ada"})["status"], "ok")
        self.assertEqual(handle_upload(store, {"name": "notes.txt", "size": 20, "owner": "bob"})["status"], "ok")
        self.assertEqual(store.names(), ["notes.txt"])

    def test_rejected(self):
        store = Store()
        result = handle_upload(store, {"name": "virus.exe", "size": 10, "owner": "eve"})
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(handle_upload(store, {"name": "big.png", "size": 10**9, "owner": "eve"})["status"], "rejected")
        self.assertEqual(store.names(), [])


if __name__ == "__main__":
    unittest.main()
