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
        meter, day, clock, kwh = re.split(r"\s+", line.strip())
        readings.append(Reading(meter, datetime.strptime(day + clock, "%Y%m%d%H%M"), float(kwh)))
    return readings
