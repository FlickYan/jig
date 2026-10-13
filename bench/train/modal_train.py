"""Milestone 27: a LoRA of Qwen2.5-7B-Instruct on bench/dataset, on one of Modal's H100s, trained on the
model's own tokens only, with its loss on the held-out tasks before and after each epoch. (Not the Coder
model: Qwen2.5-Coder-7B-Instruct wrote its tool calls as XML in a code block instead of the <tool_call>
its chat template asks for, so jig got no calls from it at all, and a comparison would have measured the
format being learnt.)

milestone 26 found that a loss over every token mostly measures the system prompt and the tools learnt by
heart, so here the labels are the assistant's messages (its replies and tool calls) and nothing else, and
only those positions get logits at all, which is also what lets a 32k-token example fit in memory.

    bench/train/.venv/bin/modal run bench/train/modal_train.py [--run <name>] [--epochs 2]

The adapter after the last epoch is the one evaluated (decided before training, so nothing is chosen on
the held-out tasks); each epoch's goes to the jig-train volume, under adapters/<run>/epoch-<n>.
"""

import json
import sys
from pathlib import Path

import modal

MODEL = "Qwen/Qwen2.5-7B-Instruct"
MAX_TOKENS = 32768  # each example's first tokens: 6 of the 294 training examples are longer

app = modal.App("jig-train")
volume = modal.Volume.from_name("jig-train", create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install(
        "torch==2.7.1",
        "transformers==4.54.0",
        "peft==0.16.0",
        "accelerate==1.9.0",
        "hf-transfer==0.1.9",
        "huggingface_hub==0.34.2",
    )
    .env({"HF_HOME": "/vol/hf", "HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


def own_tokens(tokenizer, example: dict, max_tokens: int):
    """The conversation's token ids, and labels that are the ids on the assistant's messages and -100 elsewhere
    (None if the chat template doesn't build the conversation from its beginnings, which would put them wrong)."""
    messages, tools = example["messages"], example.get("tools")
    template = lambda part, **kw: tokenizer.apply_chat_template(part, tools=tools, tokenize=True, return_dict=False, **kw)  # noqa: E731
    ids = template(messages)
    labels = [-100] * len(ids)
    for i, message in enumerate(messages):
        if message["role"] != "assistant":
            continue
        asked, answered = template(messages[:i], add_generation_prompt=True), template(messages[: i + 1])
        if ids[: len(asked)] != asked or ids[: len(answered)] != answered:
            return None
        labels[len(asked) : len(answered)] = ids[len(asked) : len(answered)]
    return ids[:max_tokens], labels[:max_tokens]


@app.function(image=image, gpu="H100", volumes={"/vol": volume}, timeout=4 * 60 * 60)
def train(run: str, epochs: int, rank: int, learning_rate: float, limit: int = 0, base: str = MODEL) -> dict:
    import math
    import random
    import time

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, get_cosine_schedule_with_warmup

    data = Path("/vol/data")
    tokenizer = AutoTokenizer.from_pretrained(base)
    load = lambda name: [json.loads(line) for line in (data / name).read_text().splitlines()]  # noqa: E731
    encoded = {name: [own_tokens(tokenizer, e, MAX_TOKENS) for e in load(f"{name}.jsonl")] for name in ("train", "heldout")}
    unstable = {name: sum(x is None for x in rows) for name, rows in encoded.items()}
    encoded = {name: [x for x in rows if x is not None][: limit or None] for name, rows in encoded.items()}
    print(f"examples: {[(n, len(r)) for n, r in encoded.items()]}, left out (template not prefix-stable): {unstable}", flush=True)

    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda")
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    lora = LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    decoder, head = model.base_model.model.model, model.base_model.model.lm_head

    def loss_of(ids: list[int], labels: list[int]):
        """Mean cross-entropy over the labelled positions; logits only where there is a label."""
        hidden = decoder(input_ids=torch.tensor([ids], device="cuda"), use_cache=False).last_hidden_state[0, :-1]
        targets = torch.tensor(labels[1:], device="cuda")
        keep = targets != -100
        logits = head(hidden[keep]).float()
        return torch.nn.functional.cross_entropy(logits, targets[keep], reduction="sum"), int(keep.sum())

    @torch.no_grad()
    def held_out_loss() -> float:
        model.eval()
        total = count = 0
        for ids, labels in encoded["heldout"]:
            loss, n = loss_of(ids, labels)
            total, count = total + float(loss), count + n
        model.train()
        return total / count

    history = {"before": held_out_loss()}
    print(f"held-out loss on the model's own tokens, before: {history['before']:.4f}", flush=True)
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=learning_rate, weight_decay=0.0)
    accumulate = 8
    steps = math.ceil(len(encoded["train"]) / accumulate) * epochs
    schedule = get_cosine_schedule_with_warmup(optimizer, num_warmup_steps=max(1, steps // 20), num_training_steps=steps)
    rng = random.Random(1)
    model.train()
    started = time.time()
    for epoch in range(1, epochs + 1):
        order = list(range(len(encoded["train"])))
        rng.shuffle(order)
        running, tokens = 0.0, 0
        for i, index in enumerate(order, 1):
            ids, labels = encoded["train"][index]
            loss, n = loss_of(ids, labels)
            (loss / max(n, 1) / accumulate).backward()
            running, tokens = running + float(loss), tokens + n
            if i % accumulate == 0 or i == len(order):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                schedule.step()
                optimizer.zero_grad(set_to_none=True)
            if i % 40 == 0:
                print(f"epoch {epoch}, example {i}/{len(order)}: train loss {running / max(tokens, 1):.4f}, {time.time() - started:.0f}s", flush=True)
        history[f"epoch {epoch}"] = held_out_loss()
        out = Path(f"/vol/adapters/{run}/epoch-{epoch}")
        model.save_pretrained(out)
        tokenizer.save_pretrained(out)
        volume.commit()
        print(f"epoch {epoch}: train loss {running / max(tokens, 1):.4f}, held-out loss {history[f'epoch {epoch}']:.4f}, saved {out}", flush=True)
    history["seconds"] = round(time.time() - started)
    history["examples"] = {name: len(rows) for name, rows in encoded.items()}
    history["own tokens"] = {name: sum(sum(1 for t in labels if t != -100) for _, labels in rows) for name, rows in encoded.items()}
    # Kept with the adapters too, so a client that went away (modal run --detach) loses nothing.
    Path(f"/vol/adapters/{run}/history.json").write_text(json.dumps(history, indent=2) + "\n")
    volume.commit()
    return history


@app.local_entrypoint()
def main(run: str = "qwen25-7b-r16", epochs: int = 2, rank: int = 16, learning_rate: float = 1e-4, limit: int = 0, base: str = MODEL):
    sys.path.insert(0, str(Path(__file__).parent))
    from to_mlx import convert  # tool calls' arguments as objects, as the chat template expects

    dataset = Path(__file__).resolve().parent.parent / "dataset"
    with volume.batch_upload(force=True) as batch:
        for name in ("train", "heldout"):
            rows = [convert(json.loads(line)) for line in (dataset / f"{name}.jsonl").read_text().splitlines()]
            local = dataset / f"modal-{name}.jsonl"  # bench/dataset/ isn't committed
            local.write_text("".join(json.dumps(row) + "\n" for row in rows))
            batch.put_file(local, f"/data/{name}.jsonl")
            print(f"uploaded {name}: {len(rows)} examples")
    history = train.remote(run, epochs, rank, learning_rate, limit, base)  # limit: a smoke test on the first few
    print(json.dumps(history, indent=2))
    out = Path(__file__).resolve().parent / f"{run}.json"
    out.write_text(json.dumps({"model": base, "run": run, "epochs": epochs, "rank": rank, "learning_rate": learning_rate, **history}, indent=2) + "\n")
    print(f"saved {out}")
