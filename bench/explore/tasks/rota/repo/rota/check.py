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
