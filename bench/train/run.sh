#!/bin/bash
# Milestone 26's smoke test of training on bench/dataset: a LoRA of Qwen2.5-0.5B-Instruct (4-bit) with MLX,
# on an Apple Silicon Mac, and its loss on the held-out tasks before and after. Local and free: it shows
# that the data trains and what moves, not that the result is a better agent.
#
#   bench/train/run.sh <work dir>      (node bench/dataset.ts first)
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK=${1:?a directory for the virtualenv, the data, the model and the adapters}
MODEL=mlx-community/Qwen2.5-0.5B-Instruct-4bit
export HF_HOME=$WORK/hf

[ -x "$WORK/mlx/bin/python" ] || { python3 -m venv "$WORK/mlx" && "$WORK/mlx/bin/pip" install -q mlx-lm; }
python3 bench/train/to_mlx.py "$WORK/data"

# 4,096 tokens a sequence is what fits beside Docker in 8 GB: each example's first 4,096 are trained on.
COMMON=(--model $MODEL --data "$WORK/data" --max-seq-length 4096 --batch-size 1 --grad-checkpoint --seed 1)
"$WORK/mlx/bin/mlx_lm.lora" "${COMMON[@]}" --train --iters 332 --learning-rate 1e-5 --steps-per-eval 83 --val-batches -1 \
  --adapter-path "$WORK/adapters" --test --test-batches -1

for adapter in "" "$WORK/adapters"; do
  "$WORK/mlx/bin/python" bench/train/heldout_loss.py --model $MODEL ${adapter:+--adapter-path "$adapter"} --data "$WORK/data/test.jsonl"
done
