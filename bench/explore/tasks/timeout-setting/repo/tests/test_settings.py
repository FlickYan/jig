import unittest

from syncer.settings import load


class SettingsTest(unittest.TestCase):
    def test_staging(self):
        self.assertEqual(load({"APP_ENV": "staging"})["page_size"], 20)

    def test_bad_values_stop_the_program(self):
        with self.assertRaises(ValueError):
            load({"SYNCER_RETRIES": "-1"})
