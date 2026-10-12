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
