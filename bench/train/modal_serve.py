"""Milestone 27: Qwen2.5-7B-Instruct and its LoRA behind one vLLM server on Modal, an OpenAI-compatible API
jig can drive (--api openai --base-url <url>/v1) as the model qwen-base or jig. One server for both, so they
run on the same GPU and the same software; a token keeps anyone else out. With JIG_ADAPTER empty, only the
base model is served.

    JIG_SERVE_KEY=<token> [JIG_ADAPTER=qwen25-7b-r16/epoch-2] [JIG_BASE_MODEL=...] bench/train/.venv/bin/modal deploy bench/train/modal_serve.py
"""

import os
import subprocess

import modal

app = modal.App("jig-serve")
image = (
    modal.Image.from_registry("nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install("vllm==0.21.0")
    .env({"HF_XET_HIGH_PERFORMANCE": "1"})
)
hf_cache = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
train_volume = modal.Volume.from_name("jig-train", create_if_missing=True)
# Set when deploying, read in the container: the token, and which adapter (under the volume's adapters/).
settings = modal.Secret.from_dict(
    {key: os.environ.get(key, default) for key, default in [("JIG_SERVE_KEY", ""), ("JIG_ADAPTER", "qwen25-7b-r16/epoch-2"), ("JIG_BASE_MODEL", "Qwen/Qwen2.5-7B-Instruct")]}
)


@app.server(
    image=image,
    gpu="L40S",
    scaledown_window=15 * 60,
    startup_timeout=20 * 60,
    volumes={"/root/.cache/huggingface": hf_cache, "/vol": train_volume},
    port=8000,
    target_concurrency=16,
    unauthenticated=True,  # vLLM checks the token instead
    secrets=[settings],
)
class Server:
    @modal.enter()
    def start(self):
        if not os.environ.get("JIG_SERVE_KEY"):
            raise RuntimeError("Deploy with JIG_SERVE_KEY set: without it the server would be open to anyone.")
        cmd = [
            "vllm", "serve", os.environ["JIG_BASE_MODEL"],
            "--served-model-name", "qwen-base",
            "--host", "0.0.0.0", "--port", "8000",
            "--max-model-len", "32768",
            # Qwen2.5's tool calls are Hermes-style <tool_call> blocks
            "--enable-auto-tool-choice", "--tool-call-parser", "hermes",
            "--api-key", os.environ["JIG_SERVE_KEY"],
        ]
        if os.environ.get("JIG_ADAPTER"):
            cmd += ["--enable-lora", "--max-lora-rank", "16", "--lora-modules", f"jig=/vol/adapters/{os.environ['JIG_ADAPTER']}"]
        print(*[c if c != os.environ["JIG_SERVE_KEY"] else "[token]" for c in cmd])
        self.process = subprocess.Popen(cmd)

    @modal.exit()
    def stop(self):
        self.process.terminate()
