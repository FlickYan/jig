#!/bin/bash
# Generates the access log and commits it, so the task starts from a clean working tree.
set -e
mkdir -p logs
python3 "$TASK_DIR/make_log.py" > logs/access.log
git add -A && git commit -qm "Add the access log"
