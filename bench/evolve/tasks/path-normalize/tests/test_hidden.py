import unittest

from urlpath import normalize


class TestSpec(unittest.TestCase):
    def test_percent_encoding(self):
        self.assertEqual(normalize("/%7Euser/%41bc"), "/~user/Abc")
        self.assertEqual(normalize("/a%2fb"), "/a%2Fb")
        self.assertEqual(normalize("/caf%c3%a9"), "/caf%C3%A9")
        self.assertEqual(normalize("/a%2Fb/../c"), "/c")

    def test_dot_segments_after_decoding(self):
        self.assertEqual(normalize("/a/%2E%2E/b"), "/b")
        self.assertEqual(normalize("/a/%2e/b"), "/a/b")

    def test_above_root(self):
        self.assertEqual(normalize("/../a"), "/a")
        self.assertEqual(normalize("/a/../../b"), "/b")

    def test_trailing(self):
        self.assertEqual(normalize("/a/b/"), "/a/b/")
        self.assertEqual(normalize("/a/b/.."), "/a/")
        self.assertEqual(normalize("/a/."), "/a/")
        self.assertEqual(normalize("/a/%2E"), "/a/")
        self.assertEqual(normalize("/.."), "/")

    def test_leading_slash(self):
        self.assertEqual(normalize("a/b"), "/a/b")
        self.assertEqual(normalize(""), "/")
        self.assertEqual(normalize("/"), "/")

    def test_bad_escapes(self):
        for bad in ["/%G1", "/a%2", "/%", "/%%41"]:
            with self.assertRaises(ValueError, msg=bad):
                normalize(bad)


if __name__ == "__main__":
    unittest.main()
