import importlib.util, itertools, random
from datetime import date, datetime
from dateutil.rrule import rrulestr
spec = importlib.util.spec_from_file_location("rrule_solution", "rrule_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rng = random.Random(3)
def rule():
    freq = rng.choice(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
    parts = [f"FREQ={freq}"]
    if rng.random() < 0.4: parts.append(f"INTERVAL={rng.choice([1, 2, 3, 5])}")
    if rng.random() < 0.4: parts.append(f"BYMONTH={','.join(map(str, rng.sample(range(1, 13), rng.choice([1, 2, 3]))))}")
    if freq != "WEEKLY" and rng.random() < 0.35: parts.append(f"BYMONTHDAY={','.join(map(str, rng.sample([1, 2, 13, 15, 28, 29, 30, 31, -1, -2, -7], rng.choice([1, 2]))))}")
    if rng.random() < 0.5:
        days = rng.sample(["MO", "TU", "WE", "TH", "FR", "SA", "SU"], rng.choice([1, 2, 5]))
        if freq in ("MONTHLY", "YEARLY") and rng.random() < 0.5:
            days = [f"{rng.choice([1, 2, 3, 4, -1, -2, 5, 20, -10] if freq == 'YEARLY' else [1, 2, 3, 4, -1, -2, 5])}{d}" for d in days]
        parts.append("BYDAY=" + ",".join(days))
    if freq in ("MONTHLY", "YEARLY") and len(parts) > 1 and rng.random() < 0.3: parts.append(f"BYSETPOS={','.join(map(str, rng.sample([1, 2, -1, -2, 3], rng.choice([1, 2]))))}")
    if rng.random() < 0.5: parts.append(f"COUNT={rng.choice([1, 3, 7, 12])}")
    elif rng.random() < 0.3: parts.append(f"UNTIL={rng.choice(['20250301', '20251231', '20260615'])}")
    rng.shuffle(parts)
    return ";".join(parts)
bad = n = 0
for _ in range(3000):
    text = rule()
    start = date(2024, 1, 1) + __import__("datetime").timedelta(days=rng.randrange(0, 900))
    limit = 15
    try:
        want = [d.date() for d in itertools.islice(rrulestr(text, dtstart=datetime(start.year, start.month, start.day)), limit)]
    except IndexError:
        continue  # a dateutil bug on some ordinals
    if not want and "COUNT" not in text and "UNTIL" not in text:
        continue  # a rule that never matches: not something to test
    try:
        got = m.occurrences(text, start, limit)
    except Exception as e:
        got = f"raised {e!r}"
    n += 1
    if got != want:
        bad += 1
        if bad <= 10: print("MISMATCH", text, start, "\n  dateutil", want, "\n  mine    ", got)
print(n, "rules,", bad, "mismatches")
