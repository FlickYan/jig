"""The league table for a list of results. See SPEC.md."""
import re
from collections import namedtuple

Row = namedtuple("Row", "position team played won drawn lost goals_for goals_against goal_difference points")
TEAM = r"[A-Za-z]+(?: [A-Za-z]+)*"
RESULT = re.compile(rf"({TEAM}) (\d+)-(\d+) ({TEAM})")
WALKOVER = re.compile(rf"({TEAM}) w/o ({TEAM})")
DEDUCTION = re.compile(rf"({TEAM}) -([1-9]\d*)")


def standings(results, deductions_head_to_head=False):
    matches, deducted = [], {}
    for number, line in enumerate(results, 1):
        line = line.strip()
        if match := RESULT.fullmatch(line):
            home, home_goals, away_goals, away = match.group(1), int(match.group(2)), int(match.group(3)), match.group(4)
        elif match := WALKOVER.fullmatch(line):
            home, home_goals, away_goals, away = match.group(1), 3, 0, match.group(2)
        elif match := DEDUCTION.fullmatch(line):
            deducted[match.group(1)] = deducted.get(match.group(1), 0) + int(match.group(2))
            continue
        else:
            raise ValueError(f"line {number} isn't a result: {line!r}")
        if home == away:
            raise ValueError(f"line {number}: a team can't play itself")
        matches.append((home, home_goals, away_goals, away))
    overall = _table(matches)
    for team, points in deducted.items():
        overall.setdefault(team, _empty())["points"] -= points
    groups = []
    for points in sorted({s["points"] for s in overall.values()}, reverse=True):
        groups += _rank([t for t, s in overall.items() if s["points"] == points], matches, overall, deducted if deductions_head_to_head else {})
    rows, position = [], 1
    for group in groups:
        for team in group:
            s = overall[team]
            rows.append(Row(position, team, s["played"], s["won"], s["drawn"], s["lost"], s["for"], s["against"], s["for"] - s["against"], s["points"]))
        position += len(group)
    return rows


def _empty():
    return {"played": 0, "won": 0, "drawn": 0, "lost": 0, "for": 0, "against": 0, "points": 0}


def _table(matches, teams=None):
    table = {}
    for home, home_goals, away_goals, away in matches:
        if teams is not None and not (home in teams and away in teams):
            continue
        for team, scored, conceded in ((home, home_goals, away_goals), (away, away_goals, home_goals)):
            s = table.setdefault(team, _empty())
            s["played"] += 1
            s["for"] += scored
            s["against"] += conceded
            if scored > conceded:
                s["won"] += 1
                s["points"] += 3
            elif scored == conceded:
                s["drawn"] += 1
                s["points"] += 1
            else:
                s["lost"] += 1
    return table


def _rank(group, matches, overall, deducted):
    """Teams level on points, in order, as groups of teams that share a position."""
    if len(group) == 1:
        return [group]
    mini = _table(matches, set(group))

    def head_to_head(team):
        s = mini.get(team, _empty())
        return (s["points"] - deducted.get(team, 0), s["for"] - s["against"], s["for"])

    levels = sorted({head_to_head(team) for team in group}, reverse=True)
    if len(levels) == 1:
        overall_key = lambda team: (overall[team]["for"] - overall[team]["against"], overall[team]["for"])
        return [sorted(t for t in group if overall_key(t) == key) for key in sorted({overall_key(t) for t in group}, reverse=True)]
    ranked = []
    for level in levels:
        ranked += _rank([team for team in group if head_to_head(team) == level], matches, overall, deducted)
    return ranked
