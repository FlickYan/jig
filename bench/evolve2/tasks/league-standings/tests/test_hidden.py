import unittest

from league import standings


class TestSpec(unittest.TestCase):
    def check(self, cases):
        for results, expected in cases:
            with self.subTest(results=results):
                self.assertEqual([tuple(row) for row in standings(results)], expected)

    def test_points_and_rows(self):
        self.check([
            (['Ajax 3-1 Benfica', 'Celtic 0-0 Ajax', 'Benfica 2-2 Celtic'], [(1, 'Ajax', 2, 1, 1, 0, 3, 1, 2, 4), (2, 'Celtic', 2, 0, 2, 0, 2, 2, 0, 2), (3, 'Benfica', 2, 0, 1, 1, 3, 5, -2, 1)]),
        ])

    def test_head_to_head_before_goal_difference(self):
        self.check([
            (['Ajax 1-0 Benfica', 'Benfica 3-0 Dynamo', 'Dynamo 2-0 Ajax', 'Celtic 0-0 Dynamo'], [(1, 'Dynamo', 3, 1, 1, 1, 2, 3, -1, 4), (2, 'Ajax', 2, 1, 0, 1, 1, 2, -1, 3), (3, 'Benfica', 2, 1, 0, 1, 3, 1, 2, 3), (4, 'Celtic', 1, 0, 1, 0, 0, 0, 0, 1)]),
        ])

    def test_head_to_head_again_among_teams_still_level(self):
        self.check([
            (['Ajax 3-0 Porto', 'Porto 2-0 Celtic', 'Celtic 2-1 Ajax', 'Ajax 1-1 Dynamo', 'Porto 0-0 Dynamo', 'Celtic 3-3 Dynamo'], [(1, 'Ajax', 3, 1, 1, 1, 5, 3, 2, 4), (2, 'Porto', 3, 1, 1, 1, 2, 3, -1, 4), (3, 'Celtic', 3, 1, 1, 1, 5, 6, -1, 4), (4, 'Dynamo', 3, 0, 3, 0, 4, 4, 0, 3)]),
        ])

    def test_every_meeting_counts_head_to_head(self):
        self.check([
            (['Ajax 1-0 Benfica', 'Benfica 2-0 Ajax', 'Ajax 5-0 Celtic', 'Benfica 1-0 Celtic'], [(1, 'Benfica', 3, 2, 0, 1, 3, 1, 2, 6), (2, 'Ajax', 3, 2, 0, 1, 6, 2, 4, 6), (3, 'Celtic', 2, 0, 0, 2, 0, 6, -6, 0)]),
        ])

    def test_teams_that_never_met(self):
        self.check([
            (['Ajax 2-0 Dynamo', 'Benfica 1-0 Celtic'], [(1, 'Ajax', 1, 1, 0, 0, 2, 0, 2, 3), (2, 'Benfica', 1, 1, 0, 0, 1, 0, 1, 3), (3, 'Celtic', 1, 0, 0, 1, 0, 1, -1, 0), (4, 'Dynamo', 1, 0, 0, 1, 0, 2, -2, 0)]),
        ])

    def test_goals_scored_then_name(self):
        self.check([
            (['Zenit 2-2 Ajax', 'Ajax 0-1 Celtic', 'Zenit 1-2 Celtic'], [(1, 'Celtic', 2, 2, 0, 0, 3, 1, 2, 6), (2, 'Zenit', 2, 0, 1, 1, 3, 4, -1, 1), (3, 'Ajax', 2, 0, 1, 1, 2, 3, -1, 1)]),
            (['Zenit 1-1 Ajax'], [(1, 'Ajax', 1, 0, 1, 0, 1, 1, 0, 1), (1, 'Zenit', 1, 0, 1, 0, 1, 1, 0, 1)]),
        ])

    def test_names_spaces_and_big_scores(self):
        self.check([
            (['  Real Madrid 2-1 Bayern Munich  ', 'Bayern Munich 10-0 Real Madrid'], [(1, 'Bayern Munich', 2, 1, 0, 1, 11, 2, 9, 3), (2, 'Real Madrid', 2, 1, 0, 1, 2, 11, -9, 3)]),
            ([], []),
        ])

    def test_deductions_count_in_the_table_but_not_head_to_head(self):
        self.check([
            (['Ajax 2-2 Benfica', 'Ajax 2-3 Celtic', 'Ajax 1-1 Dynamo', 'Benfica 0-2 Celtic', 'Benfica 2-2 Dynamo', 'Celtic 1-3 Dynamo', 'Dynamo -3'], [(1, 'Celtic', 3, 2, 0, 1, 6, 5, 1, 6), (2, 'Benfica', 3, 0, 2, 1, 4, 6, -2, 2), (3, 'Dynamo', 3, 1, 2, 0, 6, 4, 2, 2), (4, 'Ajax', 3, 0, 2, 1, 5, 6, -1, 2)]),
            (['Ajax 1-0 Benfica', 'Benfica 1-0 Celtic', 'Celtic 1-0 Ajax', 'Ajax -3'], [(1, 'Benfica', 2, 1, 0, 1, 1, 1, 0, 3), (2, 'Celtic', 2, 1, 0, 1, 1, 1, 0, 3), (3, 'Ajax', 2, 1, 0, 1, 1, 1, 0, 0)]),
            (['Ajax -3', 'Benfica 0-0 Celtic', 'Ajax -2'], [(1, 'Benfica', 1, 0, 1, 0, 0, 0, 0, 1), (1, 'Celtic', 1, 0, 1, 0, 0, 0, 0, 1), (3, 'Ajax', 0, 0, 0, 0, 0, 0, 0, -5)]),
        ])

    def test_walkovers_are_three_nil(self):
        self.check([
            (['Ajax w/o Benfica', 'Benfica 1-0 Celtic'], [(1, 'Ajax', 1, 1, 0, 0, 3, 0, 3, 3), (2, 'Benfica', 2, 1, 0, 1, 1, 3, -2, 3), (3, 'Celtic', 1, 0, 0, 1, 0, 1, -1, 0)]),
            (['Celtic 1-0 Ajax', 'Ajax w/o Celtic', 'Benfica 0-0 Celtic'], [(1, 'Celtic', 3, 1, 1, 1, 1, 3, -2, 4), (2, 'Ajax', 2, 1, 0, 1, 3, 1, 2, 3), (3, 'Benfica', 1, 0, 1, 0, 0, 0, 0, 1)]),
        ])

    def test_teams_level_on_everything_share_a_position(self):
        self.check([
            (['Zenit 1-1 Ajax'], [(1, 'Ajax', 1, 0, 1, 0, 1, 1, 0, 1), (1, 'Zenit', 1, 0, 1, 0, 1, 1, 0, 1)]),
            (['Zenit 1-1 Ajax', 'Celtic 0-2 Dynamo'], [(1, 'Dynamo', 1, 1, 0, 0, 2, 0, 2, 3), (2, 'Ajax', 1, 0, 1, 0, 1, 1, 0, 1), (2, 'Zenit', 1, 0, 1, 0, 1, 1, 0, 1), (4, 'Celtic', 1, 0, 0, 1, 0, 2, -2, 0)]),
            (['Ajax 1-1 Benfica', 'Celtic 1-1 Dynamo', 'Ajax 0-0 Celtic', 'Benfica 0-0 Dynamo'], [(1, 'Ajax', 2, 0, 2, 0, 1, 1, 0, 2), (1, 'Benfica', 2, 0, 2, 0, 1, 1, 0, 2), (1, 'Celtic', 2, 0, 2, 0, 1, 1, 0, 2), (1, 'Dynamo', 2, 0, 2, 0, 1, 1, 0, 2)]),
        ])

    def test_lines_that_arent_results(self):
        for line in ['Ajax 3-1', 'Ajax 3:1 Benfica', 'Ajax 3-1 Ajax', 'Ajax  3-1 Benfica', '3-1 Benfica', 'Ajax -1-0 Benfica', '', 'Ajax 3-1 Benfica 2', 'Ajax 1-1 Ben-fica', 'Ajax 1 - 1 Benfica', 'Ajax -0', 'Ajax - 3', 'Ajax +3', 'Ajax w/o Ajax', 'Ajax w/o', 'w/o Benfica', 'Ajax -3 Benfica', 'Ajax W/O Benfica']:
            with self.subTest(line=line):
                with self.assertRaises(ValueError):
                    standings(["Ajax 1-0 Celtic", line])


if __name__ == "__main__":
    unittest.main()
