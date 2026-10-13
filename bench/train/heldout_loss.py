"""A model's loss on held-out examples, apart for the tokens the model wrote (its replies and tool calls)
and the rest (the system prompt and tools, the task, the tools' output), with or without a LoRA adapter.

The trainer's own test loss counts every token, and the system prompt and tool definitions are the same
in every example: a model that learns them by heart scores better on held-out tasks without having
learnt anything about the work. The model's own tokens are what training on its successes is for.

    python bench/train/heldout_loss.py --model <mlx model> [--adapter-path <dir>] --data <test.jsonl>
"""

import argparse
import json

import mlx.core as mx
import mlx.nn as nn
from mlx_lm import load


def own_spans(tokenizer, messages: list[dict], tools, full: list[int]) -> list[tuple[int, int]] | None:
    """
    The assistant messages' token ranges: from the prompt that asks for each to the end of it. None if
    the chat template doesn't build the whole conversation from its beginnings (then the ranges would be
    wrong), checked against the whole conversation's tokens.
    """
    spans = []
    for i, message in enumerate(messages):
        if message["role"] == "assistant":
            asked = tokenizer.apply_chat_template(messages[:i], tools=tools, add_generation_prompt=True)
            answered = tokenizer.apply_chat_template(messages[: i + 1], tools=tools)
            if full[: len(asked)] != asked or full[: len(answered)] != answered:
                return None
            spans.append((len(asked), len(answered)))
    return spans


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter-path")
    parser.add_argument("--data", required=True)
    parser.add_argument("--max-tokens", type=int, default=4096, help="each example's first tokens, as in training")
    args = parser.parse_args()
    model, tokenizer = load(args.model, adapter_path=args.adapter_path)
    head = model.model.embed_tokens.as_linear if model.args.tie_word_embeddings else model.lm_head
    totals = {"own": [0.0, 0], "rest": [0.0, 0]}
    unstable = 0
    for line in open(args.data):
        example = json.loads(line)
        messages, tools = example["messages"], example.get("tools")
        full = tokenizer.apply_chat_template(messages, tools=tools)
        spans = own_spans(tokenizer, messages, tools, full)
        if spans is None:
            unstable += 1
            continue
        ids = full[: args.max_tokens]
        own = [False] * len(ids)
        for start, end in spans:
            for t in range(start, min(end, len(ids))):
                own[t] = True
        hidden = model.model(mx.array(ids)[None])
        losses = []
        for s in range(0, len(ids) - 1, 512):  # the logits, a slice at a time: all of them at once won't fit
            e = min(s + 512, len(ids) - 1)
            logits = head(hidden[:, s:e])[0].astype(mx.float32)
            losses.append(nn.losses.cross_entropy(logits, mx.array(ids[s + 1 : e + 1]), reduction="none"))
        for t, loss in enumerate(mx.concatenate(losses).tolist()):  # position t predicts token t + 1
            part = totals["own" if own[t + 1] else "rest"]
            part[0] += loss
            part[1] += 1
    result = {part: round(total / count, 4) for part, (total, count) in totals.items()}
    result["all"] = round(sum(t for t, _ in totals.values()) / sum(c for _, c in totals.values()), 4)
    result["tokens"] = {part: count for part, (_, count) in totals.items()}
    result["left out"] = unstable
    print(json.dumps(result))


if __name__ == "__main__":
    main()
