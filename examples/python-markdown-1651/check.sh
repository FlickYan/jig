#!/bin/bash
# Grades the work in a project made by setup.sh: the regression tests Python-Markdown added with its fix
# (upstream/test_issue_1651.py, which the agent never sees), then the project's whole test suite, so a fix
# that breaks something else fails. Exit code 0 when both pass.
#
#   check.sh <dir>
set -uo pipefail

WORK=${1:?usage: check.sh <dir>}
HERE=$(cd "$(dirname "$0")" && pwd)
export PYTHONDONTWRITEBYTECODE=1
cd "$WORK"

echo "== upstream's regression tests for #1651"
cp "$HERE/upstream/test_issue_1651.py" tests/test_issue_1651_upstream.py
.venv/bin/python -m unittest tests.test_issue_1651_upstream 2>&1 | grep -E '^(FAIL|ERROR): |^Ran |^OK|^FAILED'
hidden=${PIPESTATUS[0]}
rm tests/test_issue_1651_upstream.py

echo "== the whole test suite"
.venv/bin/python -m unittest discover tests 2>&1 | grep -E '^(FAIL|ERROR): |^Ran |^OK|^FAILED'
suite=${PIPESTATUS[0]}

if [[ $hidden == 0 && $suite == 0 ]]; then
  echo "== solved"
else
  echo "== not solved"
  exit 1
fi
