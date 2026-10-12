"""timeout-setting: "a setting like the others" means learning how settings work here.

What the agent must find: settings come from syncer/settings/defaults.toml, then the file for APP_ENV in
syncer/settings/environments/, then SYNCER_<NAME> environment variables, and each must be declared, with
its type and a check, in syncer/settings/schema.py. The client reads them through settings.load(). A
timeout read straight from os.environ in the client, or a default without the staging value, fails.
"""
from maketask import task

FILES = {
    "README.md": """
        # syncer

        Syncs the shop's catalogue with the marketplace's API. Settings are described in syncer/settings/.
        """,
    "syncer/__init__.py": "",
    "syncer/settings/__init__.py": '''
        """Settings, in this order, each overriding the one before:

        1. syncer/settings/defaults.toml
        2. syncer/settings/environments/<APP_ENV>.toml, if APP_ENV is set
        3. environment variables SYNCER_<NAME>, like SYNCER_RETRIES=5

        Every setting is declared in schema.py, with its type and a check, so that a typo or a bad value
        stops the program at start instead of later.
        """
        import os
        import tomllib

        from syncer.settings.schema import SCHEMA

        HERE = os.path.dirname(os.path.abspath(__file__))


        def _read(path):
            if not os.path.exists(path):
                return {}
            with open(path, "rb") as f:
                return tomllib.load(f)


        def load(environ=None):
            """The settings in effect, as a dict."""
            environ = os.environ if environ is None else environ
            values = _read(os.path.join(HERE, "defaults.toml"))
            if environ.get("APP_ENV"):
                values.update(_read(os.path.join(HERE, "environments", f"{environ['APP_ENV']}.toml")))
            for name in SCHEMA:
                if f"SYNCER_{name.upper()}" in environ:
                    values[name] = environ[f"SYNCER_{name.upper()}"]
            settings = {}
            for name, value in values.items():
                if name not in SCHEMA:
                    raise ValueError(f"unknown setting {name!r}")
                kind, check, wanted = SCHEMA[name]
                try:
                    value = kind(value)
                except (TypeError, ValueError):
                    raise ValueError(f"{name} must be {wanted}, not {value!r}") from None
                if not check(value):
                    raise ValueError(f"{name} must be {wanted}, not {value!r}")
                settings[name] = value
            return settings
        ''',
    "syncer/settings/schema.py": """
        REGIONS = ("eu", "us", "apac")

        # name: (type, check, what a good value is)
        SCHEMA = {
            "retries": (int, lambda value: value >= 0, "a whole number, 0 or more"),
            "region": (str, lambda value: value in REGIONS, f"one of {', '.join(REGIONS)}"),
            "page_size": (int, lambda value: 1 <= value <= 500, "a whole number from 1 to 500"),
        }
        """,
    "syncer/settings/defaults.toml": """
        retries = 3
        region = "eu"
        page_size = 100
        """,
    "syncer/settings/environments/staging.toml": """
        # The staging marketplace is slow and small.
        page_size = 20
        """,
    "syncer/settings/environments/production.toml": """
        retries = 5
        """,
    "syncer/client.py": """
        from syncer import settings

        TIMEOUT = 30  # seconds


        def fetch_page(transport, page):
            \"\"\"One page of the marketplace's catalogue.\"\"\"
            config = settings.load()
            return transport.get(
                f"/{config['region']}/catalogue",
                params={"page": page, "size": config["page_size"]},
                retries=config["retries"],
                timeout=TIMEOUT,
            )
        """,
    "tests/__init__.py": "",
    "tests/test_settings.py": """
        import unittest

        from syncer.settings import load


        class SettingsTest(unittest.TestCase):
            def test_staging(self):
                self.assertEqual(load({"APP_ENV": "staging"})["page_size"], 20)

            def test_bad_values_stop_the_program(self):
                with self.assertRaises(ValueError):
                    load({"SYNCER_RETRIES": "-1"})
        """,
}

SOLUTION = {
    "syncer/settings/schema.py": """
        REGIONS = ("eu", "us", "apac")

        # name: (type, check, what a good value is)
        SCHEMA = {
            "retries": (int, lambda value: value >= 0, "a whole number, 0 or more"),
            "region": (str, lambda value: value in REGIONS, f"one of {', '.join(REGIONS)}"),
            "page_size": (int, lambda value: 1 <= value <= 500, "a whole number from 1 to 500"),
            "timeout": (float, lambda value: value > 0, "a number of seconds, more than 0"),
        }
        """,
    "syncer/settings/defaults.toml": """
        retries = 3
        region = "eu"
        page_size = 100
        timeout = 30
        """,
    "syncer/settings/environments/staging.toml": """
        # The staging marketplace is slow and small.
        page_size = 20
        timeout = 60
        """,
    "syncer/client.py": """
        from syncer import settings


        def fetch_page(transport, page):
            \"\"\"One page of the marketplace's catalogue.\"\"\"
            config = settings.load()
            return transport.get(
                f"/{config['region']}/catalogue",
                params={"page": page, "size": config["page_size"]},
                retries=config["retries"],
                timeout=config["timeout"],
            )
        """,
}

HIDDEN = """
    import os
    import unittest
    from unittest import mock

    from syncer import client
    from syncer.settings import load


    class Recorder:
        def get(self, path, **kwargs):
            self.kwargs = kwargs
            return []


    class TimeoutTest(unittest.TestCase):
        def test_thirty_seconds_unless_configured(self):
            self.assertEqual(load({})["timeout"], 30)
            self.assertEqual(load({"APP_ENV": "production"})["timeout"], 30)

        def test_sixty_in_staging(self):
            self.assertEqual(load({"APP_ENV": "staging"})["timeout"], 60)

        def test_an_environment_variable_wins(self):
            self.assertEqual(load({"APP_ENV": "staging", "SYNCER_TIMEOUT": "45"})["timeout"], 45)

        def test_checked_like_the_others(self):
            for bad in ("-5", "soon"):
                with self.assertRaises(ValueError):
                    load({"SYNCER_TIMEOUT": bad})

        def test_the_client_uses_it(self):
            transport = Recorder()
            with mock.patch.dict(os.environ, {"APP_ENV": "staging"}, clear=False):
                os.environ.pop("SYNCER_TIMEOUT", None)
                client.fetch_page(transport, 1)
            self.assertEqual(transport.kwargs["timeout"], 60)
            with mock.patch.dict(os.environ, {"SYNCER_TIMEOUT": "12"}):
                client.fetch_page(transport, 1)
            self.assertEqual(transport.kwargs["timeout"], 12)
"""

task(
    "timeout-setting",
    "Make the HTTP timeout a setting like the others: 30 seconds unless it is configured otherwise, and 60 in staging.",
    ["python", "feature", "configuration", "exploration"],
    FILES,
    HIDDEN,
    SOLUTION,
)
