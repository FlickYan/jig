"""bench/dataset as mlx-lm's chat data (train.jsonl, valid.jsonl, test.jsonl in <out>), for milestone 26's
smoke test of the training. Tool calls' arguments become objects, which chat templates like Qwen's expect
(a string would be encoded twice), and examples are kept under a size the trainer can hold.

    python3 bench/train/to_mlx.py <out> [--max-tokens 8192]
"""

import argparse
import json
from pathlib import Path

DATASET = Path(__file__).resolve().parent.parent / "dataset"


def convert(example: dict) -> dict:
    messages = []
    for message in example["messages"]:
        message = dict(message)
        if message.get("tool_calls"):
            message["tool_calls"] = [
                {"type": "function", "function": {"name": call["function"]["name"], "arguments": json.loads(call["function"]["arguments"] or "{}")}}
                for call in message["tool_calls"]
            ]
            message["content"] = message.get("content") or ""
        messages.append(message)
    return {"messages": messages, **({"tools": example["tools"]} if example.get("tools") else {})}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--max-tokens", type=int, default=8192, help="leave out examples bigger than this (by the manifest's estimate)")
    args = parser.parse_args()
    manifest = json.loads((DATASET / "manifest.json").read_text())

    def load(split: str, file: str) -> list[dict]:
        sizes = [e["tokens"] for e in manifest["examples"] if e["split"] == split]
        rows = [json.loads(line) for line in (DATASET / file).read_text().splitlines()]
        assert len(rows) == len(sizes), f"{file} doesn't match the manifest: build the dataset again"
        return [convert(row) for row, size in zip(rows, sizes) if size < args.max_tokens]

    train, held_out = load("train", "train.jsonl"), load("heldout", "heldout.jsonl")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    # The trainer reports a validation loss as it goes: a slice of the held-out set, which no setting is chosen on.
    for name, rows in (("train", train), ("valid", held_out[:20]), ("test", held_out)):
        (out / f"{name}.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
        print(f"{name}: {len(rows)} examples")


if __name__ == "__main__":
    main()
