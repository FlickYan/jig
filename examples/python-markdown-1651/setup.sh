#!/bin/bash
# Makes the project jig works on: Python-Markdown at the commit before the fix for issue #1651, with the
# history up to that commit and nothing after it, and a development install in .venv. Then checks that the
# bug shows on this Python (it needs the html.parser of Python 3.13.6 or later, 3.12.14 or later, or 3.14).
#
#   setup.sh <dir>            PYTHON=python3.14 setup.sh <dir> to choose the Python
set -euo pipefail

WORK=${1:?usage: setup.sh <dir>}
PYTHON=${PYTHON:-python3}
# "Fix inline HTML case", 2026-10-03: the parent of the fix, 7c265bc (2026-10-05).
BASE=7a29324e03725fe279790c2f59d13ebda0eecbe1

mkdir -p "$WORK"
cd "$WORK"
git init -q
# Only this commit and its ancestors are fetched, and no remote is kept, so the fix isn't in the
# repository and a fetch has nowhere to go.
git fetch -q --depth 200 https://github.com/Python-Markdown/markdown "$BASE"
git checkout -q -B master FETCH_HEAD
rm -f .git/FETCH_HEAD

"$PYTHON" -m venv .venv
.venv/bin/pip install -q --disable-pip-version-check -e '.[testing]'

# The issue's symptom, or this Python can't show the bug.
out=$(.venv/bin/python -c 'import markdown; print(markdown.markdown("a `b </dev/null` c\n\nd"))')
if [[ $out == *"<p>d</p>"* ]]; then
  echo "$("$PYTHON" --version) renders the text after </dev/null, so the bug doesn't show here;" \
    "use Python 3.13.6 or later (PYTHON=...)" >&2
  exit 1
fi
echo "Python-Markdown at ${BASE:0:7} in $WORK, with $(.venv/bin/python --version); the bug shows: $out"
