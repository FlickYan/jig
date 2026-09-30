import json
import re
from collections import Counter, defaultdict

LINE = re.compile(r"^(\S+Z) (\S+) (\S+) (/\S*) (\d{3}) (\d+)ms$")

requests = Counter()
errors = Counter()
latencies = defaultdict(list)
with open("logs/access.log") as f:
    for line in f:
        m = LINE.match(line.rstrip("\n"))
        if not m:
            continue
        timestamp, ip, _, path, status, latency = m.groups()
        requests[ip] += 1
        if status.startswith("5"):
            errors[timestamp[:13]] += 1
        latencies[path].append(int(latency))

top = sorted(requests.items(), key=lambda item: (-item[1], item[0]))[:3]
averages = {path: sum(v) / len(v) for path, v in latencies.items()}
slowest = max(averages, key=averages.get)
report = {
    "top_ips": [{"ip": ip, "requests": n} for ip, n in top],
    "errors_by_hour": dict(sorted(errors.items())),
    "slowest_path": {"path": slowest, "avg_ms": round(averages[slowest], 1)},
}
with open("report.json", "w") as f:
    json.dump(report, f, indent=2)
