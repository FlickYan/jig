import unittest

from app.cli import main
from app.config import load_settings


class TestConfig(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(load_settings(env={}).max_retries, 3)

    def test_environment(self):
        self.assertEqual(load_settings(env={"APP_MAX_RETRIES": "5"}).max_retries, 5)

    def test_flag(self):
        self.assertEqual(main(["--max-retries", "2"]).max_retries, 2)


if __name__ == "__main__":
    unittest.main()
