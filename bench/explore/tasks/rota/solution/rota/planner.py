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
