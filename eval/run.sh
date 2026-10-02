#!/bin/bash
# Runs one agent on the Terminal-Bench 2.0 tasks in eval/subset.txt (or TASKS="a b c") with Harbor.
#
#   eval/run.sh <job-name> <agent> [more harbor run options]
#
# <agent> is jig (this checkout, through eval/jig_agent.py) or a Harbor agent such as mini-swe-agent.
# The model is deepseek/deepseek-flash unless MODEL says otherwise; CONCURRENCY trials run at once
# (default 1). The provider's API key comes from the environment, e.g. DEEPSEEK_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
job=$1 agent=$2
shift 2
[ "$agent" = jig ] && agent=jig_agent:Jig
args=()
for task in ${TASKS:-$(grep -v '^#' eval/subset.txt)}; do args+=(-i "$task"); done
PYTHONPATH=eval exec eval/.venv/bin/harbor run -d terminal-bench@2.0 -a "$agent" -m "${MODEL:-deepseek/deepseek-flash}" \
  "${args[@]}" -n "${CONCURRENCY:-1}" -o eval/jobs --job-name "$job" -y -q "$@"
