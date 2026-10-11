import unittest

from jsonpatch_lite import PatchError, apply_patch


class TestBasics(unittest.TestCase):
    def test_add_and_remove(self):
        patch = [{"op": "add", "path": "/b", "value": 2}, {"op": "remove", "path": "/a"}]
        self.assertEqual(apply_patch({"a": 1}, patch), {"b": 2})

    def test_failed_test(self):
        with self.assertRaises(PatchError):
            apply_patch({"a": 1}, [{"op": "test", "path": "/a", "value": 2}])


if __name__ == "__main__":
    unittest.main()
