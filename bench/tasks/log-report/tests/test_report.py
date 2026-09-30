import json
import re
import unittest
from collections import Counter, defaultdict

LINE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (\d+\.\d+\.\d+\.\d+) ([A-Z]+) (/\S*) (\d{3}) (\d+)ms$")


def expected():
    requests, errors, latencies = Counter(), Counter(), defaultdict(list)
    with open("logs/access.log") as f:
        for line in f:
            m = LINE.match(line.rstrip("\n"))
            if m:
                timestamp, ip, _, path, status, latency = m.groups()
                requests[ip] += 1
                if status.startswith("5"):
                    errors[timestamp[:13]] += 1
                latencies[path].append(int(latency))
    top = sorted(requests.items(), key=lambda item: (-item[1], item[0]))[:3]
    averages = {path: sum(v) / len(v) for path, v in latencies.items()}
    slowest = max(averages, key=averages.get)
    return top, errors, slowest, averages[slowest]


class ReportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open("report.json") as f:
            cls.report = json.load(f)
        cls.top, cls.errors, cls.slowest, cls.slowest_avg = expected()

    def test_top_ips(self):
        self.assertEqual(self.report["top_ips"], [{"ip": ip, "requests": n} for ip, n in self.top])

    def test_errors_by_hour(self):
        hours = self.report["errors_by_hour"]
        self.assertEqual(hours, dict(self.errors))
        self.assertEqual(list(hours), sorted(hours), "hours should be in ascending order")

    def test_slowest_path(self):
        self.assertEqual(self.report["slowest_path"]["path"], self.slowest)
        self.assertAlmostEqual(self.report["slowest_path"]["avg_ms"], self.slowest_avg, delta=0.051)


if __name__ == "__main__":
    unittest.main()
