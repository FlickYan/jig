"""meter-formats: the formats are in the data, not in the instruction.

What the agent must find, by opening the files in data/: each site's meters export differently. Site A
writes plain CSV (ISO times, decimal points). Site B writes semicolons and decimal commas, day-first
times, a byte-order mark and a German header. Site C writes aligned columns under a block of # comments,
with times as YYYYMMDD HHMM and a TOTAL line at the end that isn't a reading. The hidden tests load other
exports in the same three formats.
"""
from maketask import task

A = """\
meter,time,kwh
A-01,2026-09-01T00:00:00,12.5
A-01,2026-09-01T01:00:00,11.75
A-02,2026-09-01T00:00:00,3
"""
B = "﻿" + """\
Zähler;Zeitpunkt;kWh
B-7;01.09.2026 00:00;4,25
B-7;01.09.2026 01:00;1.004,5
B-9;01.09.2026 00:00;0,5
"""
C = """\
# export from meter gateway C
# site: depot
# columns: meter, date time, energy (kWh)
C-1     20260901 0000      7.20
C-1     20260901 0100     10.05
C-12    20260901 0000    123.40
TOTAL                    140.65
"""

FILES = {
    "README.md": """
        # meters

        Energy readings from the three sites' meters. Each site's gateway exports its readings as a file;
        examples from each are in data/.
        """,
    "meters/__init__.py": "",
    "meters/reading.py": """
        from dataclasses import dataclass
        from datetime import datetime


        @dataclass(frozen=True)
        class Reading:
            meter: str
            time: datetime
            kwh: float
        """,
    "meters/load.py": """
        from meters.reading import Reading


        def load_readings(path):
            \"\"\"The readings in a site's export file, in the order they appear.\"\"\"
            raise NotImplementedError
        """,
    "meters/summary.py": """
        from collections import defaultdict


        def per_meter(readings):
            totals = defaultdict(float)
            for reading in readings:
                totals[reading.meter] += reading.kwh
            return dict(totals)
        """,
}

SOLUTION = {
    "meters/load.py": '''
        import csv
        import re
        from datetime import datetime

        from meters.reading import Reading


        def load_readings(path):
            """The readings in a site's export file, in the order they appear."""
            with open(path, encoding="utf-8-sig") as f:
                text = f.read()
            first = next((line for line in text.splitlines() if line.strip()), "")
            if ";" in first:
                return _site_b(text)
            if first.startswith("#") or not "," in first:
                return _site_c(text)
            return _site_a(text)


        def _site_a(text):
            rows = list(csv.reader(text.splitlines()))[1:]
            return [Reading(meter, datetime.fromisoformat(time), float(kwh)) for meter, time, kwh in rows if meter]


        def _site_b(text):
            rows = list(csv.reader(text.splitlines(), delimiter=";"))[1:]
            readings = []
            for meter, time, kwh in (row for row in rows if row):
                number = float(kwh.replace(".", "").replace(",", "."))
                readings.append(Reading(meter, datetime.strptime(time, "%d.%m.%Y %H:%M"), number))
            return readings


        def _site_c(text):
            readings = []
            for line in text.splitlines():
                if not line.strip() or line.startswith("#") or line.startswith("TOTAL"):
                    continue
                meter, day, clock, kwh = re.split(r"\\s+", line.strip())
                readings.append(Reading(meter, datetime.strptime(day + clock, "%Y%m%d%H%M"), float(kwh)))
            return readings
        ''',
}

HIDDEN = '''
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
            self.assertEqual(self.load("meter,time,kwh\\nA-05,2026-10-02T23:00:00,0.25\\nA-06,2026-10-03T00:00:00,8\\n"), [
                Reading("A-05", datetime(2026, 10, 2, 23, 0), 0.25),
                Reading("A-06", datetime(2026, 10, 3, 0, 0), 8.0),
            ])

        def test_site_b(self):
            text = "\\ufeffZähler;Zeitpunkt;kWh\\nB-3;31.12.2026 23:00;2.345,75\\nB-4;01.01.2027 00:00;0,05\\n"
            self.assertEqual(self.load(text), [
                Reading("B-3", datetime(2026, 12, 31, 23, 0), 2345.75),
                Reading("B-4", datetime(2027, 1, 1, 0, 0), 0.05),
            ])

        def test_site_c(self):
            text = "# export from meter gateway C\\n# site: yard\\nC-40    20261103 0915      0.80\\nC-41    20261103 0930     12.00\\nTOTAL                     12.80\\n"
            self.assertEqual(self.load(text), [
                Reading("C-40", datetime(2026, 11, 3, 9, 15), 0.8),
                Reading("C-41", datetime(2026, 11, 3, 9, 30), 12.0),
            ])

        def test_the_examples(self):
            here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            counts = [len(load_readings(os.path.join(here, "data", name))) for name in ("site-a.csv", "site-b.csv", "site-c.txt")]
            self.assertEqual(counts, [3, 3, 3])
'''

task(
    "meter-formats",
    "Implement load_readings in meters/load.py so that it reads the export files of all three sites into Reading objects.",
    ["python", "data", "formats", "exploration"],
    {**FILES, "data/site-a.csv": A, "data/site-b.csv": B, "data/site-c.txt": C},
    HIDDEN,
    SOLUTION,
)
