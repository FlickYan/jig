"""upload-hang: the reference solution's name pattern accepts exactly the names the original accepts.

The original backtracks exponentially on a long name it rejects, so the names here are at most 16
characters before the extension, short enough for it to answer. Run from this directory:
python3 fuzz_names.py
"""
import importlib.util, pathlib, random

TASK = pathlib.Path(__file__).resolve().parents[1] / "tasks" / "upload-hang"


def load(path):
    spec = importlib.util.spec_from_file_location("names", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.is_valid_name


original = load(TASK / "repo" / "uploads" / "names.py")
fixed = load(TASK / "solution" / "uploads" / "names.py")

rng = random.Random(15)
SUFFIXES = [".txt", ".csv", ".json", ".png", ".jpg", ".pdf", ".TXT", "", ".txt.gz", "txt", ". txt", "-.csv", "..png"]
accepted = rejected = 0
for _ in range(100_000):
    chars = []
    for _ in range(rng.randint(0, 16)):
        roll = rng.random()
        chars.append(rng.choice("aZ7" if roll < 0.75 else "-_. " if roll < 0.95 else "é/\n#"))
    name = "".join(chars) + rng.choice(SUFFIXES)
    if original(name) != fixed(name):
        raise SystemExit(f"they differ on {name!r}: the original says {original(name)}")
    if original(name):
        accepted += 1
    else:
        rejected += 1
print(f"100,000 random names: {accepted:,} accepted by both patterns, {rejected:,} rejected by both, none differ")
