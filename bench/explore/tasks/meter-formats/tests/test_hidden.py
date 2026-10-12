import os
import tempfile
import unittest
from datetime import datetime

from meters.load import load_readings
from meters.reading import Reading


def write(text, encoding="utf-8"):
    f = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding=encoding, newline="")
    f.write(text)
    f.close()
    return f.name


class LoadTest(unittest.TestCase):
    def tearDown(self):
        for path in getattr(self, "paths", []):
            os.unlink(path)

    def load(self, text):
        self.paths = getattr(self, "paths", []) + [write(text)]
        return load_readings(self.paths[-1])

    def test_site_a(self):
        self.assertEqual(self.load("meter,time,kwh\nA-05,2026-10-02T23:00:00,0.25\nA-06,2026-10-03T00:00:00,8\n"), [
            Reading("A-05", datetime(2026, 10, 2, 23, 0), 0.25),
            Reading("A-06", datetime(2026, 10, 3, 0, 0), 8.0),
        ])

    def test_site_b(self):
        text = "\ufeffZähler;Zeitpunkt;kWh\nB-3;31.12.2026 23:00;2.345,75\nB-4;01.01.2027 00:00;0,05\n"
        self.assertEqual(self.load(text), [
            Reading("B-3", datetime(2026, 12, 31, 23, 0), 2345.75),
            Reading("B-4", datetime(2027, 1, 1, 0, 0), 0.05),
        ])

    def test_site_c(self):
        text = "# export from meter gateway C\n# site: yard\nC-40    20261103 0915      0.80\nC-41    20261103 0930     12.00\nTOTAL                     12.80\n"
        self.assertEqual(self.load(text), [
            Reading("C-40", datetime(2026, 11, 3, 9, 15), 0.8),
            Reading("C-41", datetime(2026, 11, 3, 9, 30), 12.0),
        ])

    def test_the_examples(self):
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        counts = [len(load_readings(os.path.join(here, "data", name))) for name in ("site-a.csv", "site-b.csv", "site-c.txt")]
        self.assertEqual(counts, [3, 3, 3])
