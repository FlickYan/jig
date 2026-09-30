#!/bin/bash
# Reference solution, used by `--agent oracle` to prove the task is solvable.
set -e
git merge feature >/dev/null || true
cat > app.py <<'EOF'
import logging
import sys

log = logging.getLogger("app")


def greet(name):
    log.info("greeting %s", name)
    return f"Hi {name}, welcome back!"


def main(argv):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    name = argv[1] if len(argv) > 1 else "world"
    print(greet(name))


if __name__ == "__main__":
    main(sys.argv)
EOF
git add app.py
git commit -q --no-edit
