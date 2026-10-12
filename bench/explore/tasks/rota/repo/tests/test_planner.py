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
