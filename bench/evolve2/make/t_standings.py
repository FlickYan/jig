import importlib.util
from maketask import task

spec = importlib.util.spec_from_file_location("s", "standings_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

GROUPS = {
    "test_points_and_rows": [["Ajax 3-1 Benfica", "Celtic 0-0 Ajax", "Benfica 2-2 Celtic"]],
    "test_head_to_head_before_goal_difference": [["Ajax 1-0 Benfica", "Benfica 3-0 Dynamo", "Dynamo 2-0 Ajax", "Celtic 0-0 Dynamo"]],
    "test_head_to_head_again_among_teams_still_level": [["Ajax 3-0 Porto", "Porto 2-0 Celtic", "Celtic 2-1 Ajax", "Ajax 1-1 Dynamo", "Porto 0-0 Dynamo", "Celtic 3-3 Dynamo"]],
    "test_every_meeting_counts_head_to_head": [["Ajax 1-0 Benfica", "Benfica 2-0 Ajax", "Ajax 5-0 Celtic", "Benfica 1-0 Celtic"]],
    "test_teams_that_never_met": [["Ajax 2-0 Dynamo", "Benfica 1-0 Celtic"]],
    "test_goals_scored_then_name": [["Zenit 2-2 Ajax", "Ajax 0-1 Celtic", "Zenit 1-2 Celtic"], ["Zenit 1-1 Ajax"]],
    "test_names_spaces_and_big_scores": [["  Real Madrid 2-1 Bayern Munich  ", "Bayern Munich 10-0 Real Madrid"], []],
    "test_deductions_count_in_the_table_but_not_head_to_head": [
        ["Ajax 2-2 Benfica", "Ajax 2-3 Celtic", "Ajax 1-1 Dynamo", "Benfica 0-2 Celtic", "Benfica 2-2 Dynamo", "Celtic 1-3 Dynamo", "Dynamo -3"],
        ["Ajax 1-0 Benfica", "Benfica 1-0 Celtic", "Celtic 1-0 Ajax", "Ajax -3"],
        ["Ajax -3", "Benfica 0-0 Celtic", "Ajax -2"],
    ],
    "test_walkovers_are_three_nil": [["Ajax w/o Benfica", "Benfica 1-0 Celtic"], ["Celtic 1-0 Ajax", "Ajax w/o Celtic", "Benfica 0-0 Celtic"]],
    "test_teams_level_on_everything_share_a_position": [["Zenit 1-1 Ajax"], ["Zenit 1-1 Ajax", "Celtic 0-2 Dynamo"], ["Ajax 1-1 Benfica", "Celtic 1-1 Dynamo", "Ajax 0-0 Celtic", "Benfica 0-0 Dynamo"]],
}
INVALID = ["Ajax 3-1", "Ajax 3:1 Benfica", "Ajax 3-1 Ajax", "Ajax  3-1 Benfica", "3-1 Benfica", "Ajax -1-0 Benfica", "", "Ajax 3-1 Benfica 2", "Ajax 1-1 Ben-fica", "Ajax 1 - 1 Benfica",
           "Ajax -0", "Ajax - 3", "Ajax +3", "Ajax w/o Ajax", "Ajax w/o", "w/o Benfica", "Ajax -3 Benfica", "Ajax W/O Benfica"]
for line in INVALID:
    try:
        m.standings(["Ajax 1-0 Celtic", line])
        raise SystemExit(f"accepted {line!r}")
    except ValueError:
        pass

methods = []
for method, cases in GROUPS.items():
    body = "\n".join(f"            ({lines!r}, {[tuple(row) for row in m.standings(lines)]!r})," for lines in cases)
    methods.append(f"    def {method}(self):\n        self.check([\n{body}\n        ])\n")
methods.append("    def test_lines_that_arent_results(self):\n        for line in " + repr(INVALID) + ":\n            with self.subTest(line=line):\n                with self.assertRaises(ValueError):\n                    standings([\"Ajax 1-0 Celtic\", line])\n")

hidden = '''
import unittest

from league import standings


class TestSpec(unittest.TestCase):
    def check(self, cases):
        for results, expected in cases:
            with self.subTest(results=results):
                self.assertEqual([tuple(row) for row in standings(results)], expected)

''' + "\n".join(methods) + '''

if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
# standings(results) -> list of rows

The league table for a list of lines, each a match result like `Ajax 3-1 Benfica` (the home team, each
side's goals, and the away team), a walkover, or a points deduction.

1. A team's name is one or more words of letters (`A-Z`, `a-z`) with single spaces between them. Lines
   use single spaces as shown, and spaces before or after a whole line don't matter. A line is one of:
   - a result, `<team> <goals>-<goals> <team>`, with goals as whole numbers written in digits;
   - a walkover, `<team> w/o <team>`: the first team is awarded the match 3-0, and it counts as that
     result everywhere, head to head included;
   - a deduction, `<team> -<points>`, with a positive whole number: those points come off the team's
     total. A deduction isn't a match, and counts nowhere else: not head to head (rule 4a), and not in
     goals.
   A team can't play itself. Any other line raises `ValueError`.
2. A win is worth 3 points, a draw 1 and a loss 0. Every team that a line names is in the table, even
   one that only had a deduction.
3. Teams are ranked by points (after deductions).
4. Teams level on points are ranked by these criteria, in order:
   a. Head to head: the points they took in the matches among themselves alone (all of those matches,
      if they met more than once), then their goal difference in those matches, then the goals they
      scored in them.
   b. If the head-to-head criteria rank some of the teams but leave others still level, the head-to-head
      criteria are applied again to each group of teams still level, using only the matches among the
      teams of that group, and so on for as long as they separate teams.
   c. A group of teams that the head-to-head criteria can't separate at all (each has the same
      head-to-head points, goal difference and goals) is ranked by goal difference over all their
      matches, then goals scored over all their matches.
5. Teams level on everything in rules 3 and 4 share a position, and are listed by name, in Python's
   string order. The next team's position counts every team above it: positions run 1, 2, 2, 4.
6. Each row is a tuple `(position, team, played, won, drawn, lost, goals_for, goals_against,
   goal_difference, points)` (or a namedtuple with those fields), from the top of the table down.
'''

task(
    "league-standings",
    "Implement standings in league.py so that it follows SPEC.md exactly.",
    ["python", "spec", "ranking"],
    {
        "SPEC.md": SPEC,
        "league.py": '''
            def standings(results):
                """The league table for match results like "Ajax 3-1 Benfica". See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_league.py": '''
            import unittest

            from league import standings


            class TestBasics(unittest.TestCase):
                def test_two_teams(self):
                    self.assertEqual([tuple(row) for row in standings(["Ajax 2-1 Benfica"])], [
                        (1, "Ajax", 1, 1, 0, 0, 2, 1, 1, 3),
                        (2, "Benfica", 1, 0, 0, 1, 1, 2, -1, 0),
                    ])

                def test_invalid(self):
                    with self.assertRaises(ValueError):
                        standings(["Ajax beat Benfica"])


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"league.py": open("standings_solution.py").read()},
)
