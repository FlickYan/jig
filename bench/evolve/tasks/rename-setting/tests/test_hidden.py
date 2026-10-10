import io
import json
import re
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from app.cli import main
from app.client import fetch
from app.config import Settings, load_settings, load_yaml

ROOT = Path(__file__).resolve().parent.parent


class TestRenamed(unittest.TestCase):
    def test_field(self):
        settings = Settings()
        self.assertEqual(settings.retry_limit, 3)
        self.assertFalse(hasattr(settings, "max_retries"))

    def test_new_environment_variable(self):
        self.assertEqual(load_settings(env={"APP_RETRY_LIMIT": "5"}).retry_limit, 5)

    def test_old_environment_variable_warns(self):
        err = io.StringIO()
        with redirect_stderr(err):
            settings = load_settings(env={"APP_MAX_RETRIES": "4"})
        self.assertEqual(settings.retry_limit, 4)
        self.assertIn("APP_RETRY_LIMIT", err.getvalue())

    def test_new_flag(self):
        self.assertEqual(main(["--retry-limit", "7"]).retry_limit, 7)

    def test_old_flag_warns(self):
        err = io.StringIO()
        with redirect_stderr(err):
            settings = main(["--max-retries", "6"])
        self.assertEqual(settings.retry_limit, 6)
        self.assertIn("--retry-limit", err.getvalue())

    def test_client_uses_it(self):
        calls = []

        def attempt(url):
            calls.append(url)
            raise ConnectionError("down")

        with self.assertRaises(ConnectionError):
            fetch("http://x", Settings(retry_limit=2), attempt)
        self.assertEqual(len(calls), 3)

    def test_config_file(self):
        values = load_yaml(ROOT / "config" / "default.yaml")
        self.assertIn("retry_limit", values)
        self.assertNotIn("max_retries", values)
        self.assertEqual(load_settings(env={}, file_values=values).retry_limit, 3)

    def test_schema(self):
        properties = json.loads((ROOT / "schema" / "settings.schema.json").read_text())["properties"]
        self.assertIn("retry_limit", properties)
        self.assertNotIn("max_retries", properties)

    def test_env_example(self):
        text = (ROOT / ".env.example").read_text()
        self.assertRegex(text, r"(?m)^APP_RETRY_LIMIT=")
        self.assertNotRegex(text, r"(?m)^APP_MAX_RETRIES=")

    def test_docs(self):
        text = (ROOT / "docs" / "configuration.md").read_text()
        for name in ["retry_limit", "APP_RETRY_LIMIT", "--retry-limit"]:
            self.assertIn(name, text)
        # The old names may stay, as long as the paragraph they are in says they are deprecated.
        for paragraph in re.split(r"\n\s*\n", text):
            if re.search(r"max_retries|MAX_RETRIES|max-retries", paragraph):
                self.assertIn("deprecat", paragraph.lower(), paragraph)

    def test_visible_tests_updated(self):
        self.assertNotIn("max_retries", (ROOT / "tests" / "test_config.py").read_text())


if __name__ == "__main__":
    unittest.main()
