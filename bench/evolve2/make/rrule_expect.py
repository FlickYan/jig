import importlib.util, itertools, json
from datetime import date, datetime
from dateutil.rrule import rrulestr
from rrulecases import GROUPS, INVALID
spec = importlib.util.spec_from_file_location("rrule_solution", "rrule_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = {}
for group, cases in GROUPS.items():
    rows = []
    for rule, start, limit in cases:
        s = date.fromisoformat(start)
        want = [d.date().isoformat() for d in itertools.islice(rrulestr(rule, dtstart=datetime(s.year, s.month, s.day)), limit)]
        mine = [d.isoformat() for d in m.occurrences(rule, s, limit)]
        assert mine == want, (rule, start, want, mine)
        rows.append([rule, start, limit, want])
    out[group] = rows
for rule in INVALID:
    try:
        m.occurrences(rule, date(2024, 1, 1))
        raise SystemExit(f"accepted: {rule!r}")
    except ValueError:
        pass
json.dump(out, open("rrule-expected.json", "w"), indent=1)
print(sum(len(v) for v in out.values()), "cases agree with dateutil;", len(INVALID), "invalid rules raise")
for g, rows in out.items():
    for rule, start, limit, want in rows[:2]: print(f"  {rule} from {start}: {want[:6]}")
