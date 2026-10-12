from collections import defaultdict


def per_meter(readings):
    totals = defaultdict(float)
    for reading in readings:
        totals[reading.meter] += reading.kwh
    return dict(totals)
