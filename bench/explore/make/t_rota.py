"""rota: the example week can be filled greedily; the weeks the tests use can't.

What the agent must do beyond its first check: data/week-1.json, the week the project's own test fills,
is easy, and filling each shift with whoever is free works. SPEC.md asks for any week: weeks where a
choice made early (who covers a shift that needs a skill, who works the night) rules out a later shift,
and a week that can't be filled at all, for which the answer is None. The hidden tests use such weeks,
made below and checked: a greedy fill fails on each feasible one, and the reference search fills it.
"""
import itertools
import json
import random
import signal

from maketask import task

SLOTS = ["early", "late", "night"]
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

SOLVER = '''
import itertools

SLOTS = ["early", "late", "night"]


def _order(shift):
    return shift["day"] * 3 + SLOTS.index(shift["slot"])


def _follows(first, second):
    """Whether shift `second` starts right after `first` ends."""
    return _order(second) == _order(first) + 1


def make_rota(staff, shifts):
    """{shift id: [names]} that keeps every rule in SPEC.md, or None if no rota can."""
    people = {person["name"]: person for person in staff}
    by_id = {shift["id"]: shift for shift in shifts}
    eligible = {s["id"]: [p["name"] for p in staff if s["id"] not in p.get("unavailable", [])] for s in shifts}
    # Hardest first: fewest people to spare, then the ones that need a skill.
    pending = sorted(shifts, key=lambda s: (len(eligible[s["id"]]) - s["needs"], "skill" not in s))
    rota, worked = {}, {name: [] for name in people}

    def can_work(name, shift):
        person = people[name]
        if len(worked[name]) >= person["max_shifts"]:
            return False
        return not any(_follows(by_id[w], shift) or _follows(shift, by_id[w]) for w in worked[name])

    def feasible_rest(index):
        # Every shift still to fill must have enough people who could still take it.
        for shift in pending[index:]:
            free = [n for n in eligible[shift["id"]] if can_work(n, shift)]
            if len(free) < shift["needs"]:
                return False
            if "skill" in shift and not any(shift["skill"] in people[n].get("skills", []) for n in free):
                return False
        return True

    def fill(index):
        if index == len(pending):
            return True
        shift = pending[index]
        free = [n for n in eligible[shift["id"]] if can_work(n, shift)]
        for team in itertools.combinations(free, shift["needs"]):
            if "skill" in shift and not any(shift["skill"] in people[n].get("skills", []) for n in team):
                continue
            for name in team:
                worked[name].append(shift["id"])
            rota[shift["id"]] = list(team)
            if feasible_rest(index + 1) and fill(index + 1):
                return True
            for name in team:
                worked[name].pop()
            del rota[shift["id"]]
        return False

    return dict(rota) if fill(0) else None
'''


def load_solver():
    namespace = {}
    exec(SOLVER, namespace)
    return namespace["make_rota"]


def greedy(staff, shifts):
    """Fills shifts in week order with the first free people: what a first attempt tends to do."""
    order = lambda s: s["day"] * 3 + SLOTS.index(s["slot"])
    worked = {p["name"]: [] for p in staff}
    rota = {}
    for shift in sorted(shifts, key=order):
        team = []
        for p in staff:
            n = p["name"]
            if shift["id"] in p.get("unavailable", []) or len(worked[n]) >= p["max_shifts"]:
                continue
            if any(abs(w - order(shift)) == 1 for w in worked[n]):
                continue
            team.append(n)
            if len(team) == shift["needs"]:
                break
        if len(team) < shift["needs"]:
            return None
        if "skill" in shift and not any(shift["skill"] in next(p for p in staff if p["name"] == n).get("skills", []) for n in team):
            return None
        for n in team:
            worked[n].append(order(shift))
        rota[shift["id"]] = team
    return rota


def week(rng, n_staff, days, needs, unavailable, skilled, skill_shifts, maxes):
    names = ["Ada", "Bo", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kit", "Lu", "Mo", "Ned"][:n_staff]
    shifts = [{"id": f"{DAYS[d]}-{slot}", "day": d, "slot": slot, "needs": rng.choice(needs)} for d in range(days) for slot in SLOTS]
    for shift in rng.sample(shifts, skill_shifts):
        shift["skill"] = "first-aid"
    with_skill = set(rng.sample(names, skilled))
    staff = []
    for name in names:
        away = [s["id"] for s in shifts if rng.random() < unavailable]
        staff.append({"name": name, "max_shifts": rng.choice(maxes), "unavailable": away, "skills": ["first-aid"] if name in with_skill else []})
    return {"staff": staff, "shifts": shifts}


class TooSlow(Exception):
    pass


def solve_within(seconds, w):
    """The reference search's rota, or TooSlow: weeks it can't do quickly don't go in the tests."""
    def stop(*_):
        raise TooSlow()
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(seconds)
    try:
        return load_solver()(w["staff"], w["shifts"])
    finally:
        signal.alarm(0)


def find_weeks():
    """Weeks for the hidden tests: ones a fill in week order gets wrong and the reference search fills
    within 2 seconds, made reproducibly."""
    rng = random.Random(2026)
    found = []
    while len(found) < 3:
        w = week(rng, n_staff=7, days=4, needs=[1, 2, 2], unavailable=0.2, skilled=2, skill_shifts=4, maxes=[2, 3, 4])
        if greedy(w["staff"], w["shifts"]) is not None:
            continue
        try:
            if solve_within(2, w) is not None:
                found.append(w)
        except TooSlow:
            continue
    return found


def easy_week():
    """The example week: the first one, from a fixed seed, that filling shifts in order manages."""
    rng = random.Random(7)
    while True:
        w = week(rng, n_staff=9, days=4, needs=[1, 2, 2], unavailable=0.1, skilled=3, skill_shifts=2, maxes=[3, 4])
        if greedy(w["staff"], w["shifts"]) is not None:
            return w


EASY = easy_week()
HARD = find_weeks()
# A week that can't be filled: only Ada has first aid, and both Monday's night and Tuesday's early, which
# follows it, need someone with first aid.
IMPOSSIBLE = {
    "staff": [{"name": n, "max_shifts": 5, "unavailable": [], "skills": ["first-aid"] if n == "Ada" else []} for n in ("Ada", "Bo", "Cy", "Dee", "Eli")],
    "shifts": [
        {"id": "mon-late", "day": 0, "slot": "late", "needs": 2},
        {"id": "mon-night", "day": 0, "slot": "night", "needs": 2, "skill": "first-aid"},
        {"id": "tue-early", "day": 1, "slot": "early", "needs": 2, "skill": "first-aid"},
        {"id": "tue-late", "day": 1, "slot": "late", "needs": 1},
    ],
}
assert load_solver()(IMPOSSIBLE["staff"], IMPOSSIBLE["shifts"]) is None

SPEC = """
    # make_rota(staff, shifts)

    Fills a week's shifts with staff. Returns `{shift id: [names]}`, or `None` when no rota keeps every
    rule below. Any rota that keeps them is a right answer.

    `staff` is a list of `{"name", "max_shifts", "unavailable": [shift ids], "skills": [...]}`, and
    `shifts` a list of `{"id", "day" (0 is Monday), "slot" ("early", "late" or "night"), "needs", "skill"?}`.

    1. Every shift gets exactly `needs` people, all different.
    2. Nobody works a shift they are unavailable for.
    3. Nobody works more than their `max_shifts` in the week.
    4. Nobody works two shifts in a row: early then late, late then night on the same day, or a night
       then the next day's early.
    5. A shift with a `skill` has at least one person with that skill on it.

    The café opens at most 4 days a week and has at most 9 staff; make_rota answers such a week within a
    second or two.
"""

FILES = {
    "README.md": """
        # rota

        Builds the café's weekly staff rota. The rules are in SPEC.md; data/week-1.json is last week's.
        """,
    "SPEC.md": SPEC,
    "data/week-1.json": json.dumps(EASY, indent=2) + "\n",
    "rota/__init__.py": "",
    "rota/planner.py": '''
        def make_rota(staff, shifts):
            """{shift id: [names]} that keeps every rule in SPEC.md, or None if no rota can."""
            raise NotImplementedError
        ''',
    "rota/check.py": '''
        SLOTS = ["early", "late", "night"]


        def problems(rota, staff, shifts):
            """What is wrong with a rota, by SPEC.md's rules: an empty list for a good one."""
            people = {p["name"]: p for p in staff}
            found = []
            for shift in shifts:
                team = rota.get(shift["id"], [])
                if len(team) != shift["needs"] or len(set(team)) != len(team):
                    found.append(f"{shift['id']}: needs {shift['needs']} different people, has {team}")
                if any(shift["id"] in people[n].get("unavailable", []) for n in team):
                    found.append(f"{shift['id']}: someone unavailable is on it")
                if "skill" in shift and not any(shift["skill"] in people[n].get("skills", []) for n in team):
                    found.append(f"{shift['id']}: nobody with {shift['skill']}")
            order = {s["id"]: s["day"] * 3 + SLOTS.index(s["slot"]) for s in shifts}
            for name, person in people.items():
                worked = sorted(order[s] for s, team in rota.items() if name in team)
                if len(worked) > person["max_shifts"]:
                    found.append(f"{name} works {len(worked)} shifts, more than {person['max_shifts']}")
                if any(b - a == 1 for a, b in zip(worked, worked[1:])):
                    found.append(f"{name} works two shifts in a row")
            return found
        ''',
    "tests/__init__.py": "",
    "tests/test_planner.py": """
        import json
        import os
        import unittest

        from rota.check import problems
        from rota.planner import make_rota

        HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


        class PlannerTest(unittest.TestCase):
            def test_last_week(self):
                with open(os.path.join(HERE, "data", "week-1.json")) as f:
                    week = json.load(f)
                rota = make_rota(week["staff"], week["shifts"])
                self.assertEqual(problems(rota, week["staff"], week["shifts"]), [])
        """,
}

HIDDEN = f'''
    import time
    import unittest

    from rota.check import problems
    from rota.planner import make_rota

    HARD = {json.dumps(HARD)}
    IMPOSSIBLE = {json.dumps(IMPOSSIBLE)}


    class RotaTest(unittest.TestCase):
        def test_weeks_a_first_come_fill_gets_wrong(self):
            for index, week in enumerate(HARD):
                with self.subTest(week=index):
                    started = time.perf_counter()
                    rota = make_rota(week["staff"], week["shifts"])
                    self.assertLess(time.perf_counter() - started, 10)
                    self.assertIsNotNone(rota, "this week can be filled")
                    self.assertEqual(problems(rota, week["staff"], week["shifts"]), [])

        def test_a_week_that_cant_be_filled(self):
            self.assertIsNone(make_rota(IMPOSSIBLE["staff"], IMPOSSIBLE["shifts"]))
'''

task(
    "rota",
    "Implement make_rota in rota/planner.py so that it follows SPEC.md.",
    ["python", "spec", "search", "generalization"],
    FILES,
    HIDDEN,
    {"rota/planner.py": SOLVER},
)
