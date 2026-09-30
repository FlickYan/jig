#!/bin/bash
# Reference solution, used by `--agent oracle` to prove the task is solvable.
set -e
python3 - <<'EOF'
path = "utils/helpers.py"
text = open(path).read()
bug = '    if raw.strip().startswith("+"):\n        return digits\n'
assert text.count(bug) == 1
open(path, "w").write(text.replace(bug, '    if raw.strip().startswith("+"):\n        return "+" + digits\n'))
EOF
