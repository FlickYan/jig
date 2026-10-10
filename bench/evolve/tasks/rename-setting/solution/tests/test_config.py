import unittest

from app.cli import main
from app.config import load_settings


class TestConfig(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(load_settings(env={}).retry_limit, 3)

    def test_environment(self):
        self.assertEqual(load_settings(env={"APP_RETRY_LIMIT": "5"}).retry_limit, 5)

    def test_flag(self):
        self.assertEqual(main(["--retry-limit", "2"]).retry_limit, 2)


if __name__ == "__main__":
    unittest.main()
