"""Writes a deterministic access log to stdout (run by setup.sh, so every attempt gets the same data)."""
import random
from datetime import datetime, timedelta, timezone

rng = random.Random(20260914)
ips = [f"203.0.113.{i}" for i in range(1, 41)] + [f"198.51.100.{i}" for i in range(1, 26)]
weights = [rng.random() ** 3 + 0.01 for _ in ips]
paths = {"/api/orders": 80, "/api/products": 35, "/api/cart": 50, "/api/checkout": 140, "/health": 3, "/login": 60}
methods = {"/api/orders": ["GET", "POST"], "/api/cart": ["GET", "PUT", "DELETE"], "/api/checkout": ["POST"]}
start = datetime(2026, 9, 14, 0, 0, 0, tzinfo=timezone.utc)
bad_hours = {3, 11, 12}

lines = []
t = start
for _ in range(4200):
    t += timedelta(seconds=rng.randint(1, 30))
    path = rng.choice(list(paths))
    method = rng.choice(methods.get(path, ["GET"]))
    error_rate = 0.12 if t.hour in bad_hours else 0.01
    roll = rng.random()
    status = rng.choice([500, 502, 503]) if roll < error_rate else (404 if roll < error_rate + 0.04 else 200)
    latency = max(1, int(rng.gauss(paths[path], paths[path] / 3)))
    ip = rng.choices(ips, weights)[0]
    lines.append(f"{t.strftime('%Y-%m-%dT%H:%M:%SZ')} {ip} {method} {path} {status} {latency}ms")

malformed = [
    "",
    "2026-09-14T05:00:01Z 203.0.113.5 GET /api/cart",
    "2026-09-14T06:12:44Z 203.0.113.5 GET /api/cart 200 fast",
    "#### log rotated ####",
    "2026-09-14T07:30:00Z 203.0.113.9 GET /api/products 5xx 20ms",
    "2026-09-14T09:15:10Z 198.51.100.3 POST /api/checkout 200",
]
for line in malformed:
    lines.insert(rng.randrange(len(lines)), line)
print("\n".join(lines))
