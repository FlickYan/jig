#!/bin/bash
# The whole case: a fresh project from setup.sh, jig on prompt.txt in it, and check.sh's grade. What an
# attempt leaves goes to a folder of its own in results/: what jig printed, its session (every message and
# tool call), the --stats totals, the diff of what it changed, and the grade.
#
#   run.sh [jig options]     e.g. run.sh --model claude-opus-5-5 (default: jig's, deepseek-flash)
#   AGENT=oracle run.sh      applies upstream's fix instead of running jig: must come out solved
#   AGENT=noop run.sh        changes nothing: must come out not solved
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
AGENT=${AGENT:-jig}
OUT=${OUT:-$HERE/results/$(date -u +%Y-%m-%dT%H-%M-%S)-$AGENT}
TMP=$(mktemp -d)
WORK=$TMP/markdown
mkdir -p "$OUT"

"$HERE/setup.sh" "$WORK"

case $AGENT in
  jig)
    # A home of its own, so no memory, skill or setting of this machine's takes part, and settings that
    # hide from jig's commands this folder (upstream's fix and tests) and jig's repository history. The
    # sandbox keeps the commands off the network too, so the fix can't be fetched either.
    export HOME=$TMP/home JIG_HOME=$TMP/home/.jig NO_COLOR=1
    export GIT_AUTHOR_NAME=jig GIT_AUTHOR_EMAIL=jig@example.com GIT_COMMITTER_NAME=jig GIT_COMMITTER_EMAIL=jig@example.com
    mkdir -p "$JIG_HOME"
    printf '{ "hiddenPaths": ["%s", "%s"] }\n' "$HERE" "$ROOT/.git" > "$JIG_HOME/settings.json"
    # An attempt that ends badly (the step limit, an API error) is still graded; stats.json says why it ended.
    node "$ROOT/src/cli.ts" -C "$WORK" --yes --stats "$OUT/stats.json" "$@" "$(cat "$HERE/prompt.txt")" 2>&1 |
      tee "$OUT/transcript.txt" || echo "jig exited with status $?"
    find "$JIG_HOME/sessions" -name '*.jsonl' -exec cp {} "$OUT/session.jsonl" \; 2>/dev/null || true
    ;;
  oracle) git -C "$WORK" apply --include='markdown/*' "$HERE/upstream/fix.patch" ;;
  noop) ;;
  *) echo "AGENT must be jig, oracle or noop" >&2; exit 2 ;;
esac

git -C "$WORK" add -A
git -C "$WORK" diff --cached > "$OUT/diff.patch"
"$HERE/check.sh" "$WORK" 2>&1 | tee "$OUT/check.txt" || true
echo "results in $OUT, the project in $WORK"
