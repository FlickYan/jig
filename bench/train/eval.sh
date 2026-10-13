#!/bin/bash
# Milestone 27: jig driving Qwen2.5-7B-Instruct as it is (qwen-base) and after the LoRA (jig), on every
# held-out task of the in-house suites (no example of them was trained on), 3 attempts each, with 40 steps
# (evolve2's 4 would leave a 7B model nothing to show). The server is bench/train/modal_serve.py's.
#
#   JIG_SERVE_KEY=<token> bench/train/eval.sh <server url> [label prefix]
set -euo pipefail
cd "$(dirname "$0")/../.."
URL=${1:?the server URL that modal deploy printed}
PREFIX=${2:-m27}
export OPENAI_API_KEY=${JIG_SERVE_KEY:?set JIG_SERVE_KEY, the server token}
# The server holds 32k tokens a conversation: jig compacts well before.
ARGS="--api openai --base-url $URL/v1 --compact-at 24000"
for suite in tasks evolve evolve2 explore; do
  tasks=$(node bench/dataset.ts --held-out "$suite")
  for model in qwen-base jig; do
    node bench/run.ts --suite "$suite" --tasks "$tasks" --model "$model" --attempts 3 --max-steps 40 --concurrency 6 \
      --label "$PREFIX-$model" --jig-args="$ARGS"
  done
done
