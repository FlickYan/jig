"""Checks that VERSION, package.json and src/acme/__init__.py agree, and that CHANGELOG.md has the version."""
import json, re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
version = (root / "VERSION").read_text().strip()
package = json.loads((root / "package.json").read_text())["version"]
module = re.search(r'__version__ = "([^"]+)"', (root / "src/acme/__init__.py").read_text()).group(1)
changelog = (root / "CHANGELOG.md").read_text()
problems = []
if not (version == package == module):
    problems.append(f"versions differ: VERSION {version}, package.json {package}, __init__.py {module}")
if f"## [{version}] - " not in changelog:
    problems.append(f"CHANGELOG.md has no section for {version}")
print("OK" if not problems else "\n".join(problems))
sys.exit(1 if problems else 0)
