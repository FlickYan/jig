import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { contextWindow, createModel, defaultApi, type ModelOptions } from "../src/model.ts";
import { toChatMessages, toChatTools } from "../src/openai.ts";
import { TOOLS } from "../src/tools/index.ts";
import { collectNotices } from "./notices.ts";

// jig through an OpenAI-compatible chat completions API: the translation both ways, against a local server.

type Chunk = { delta?: Record<string, unknown>; finish?: string; usage?: Record<string, unknown> };

/** An OpenAI-style stream: the deltas as chunks, then [DONE]. */
function sse(chunks: Chunk[]): string {
  const body = chunks.map(({ delta, finish, usage }) =>
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: usage ? [] : [{ index: 0, delta: delta ?? {}, finish_reason: finish ?? null }],
      ...(usage && { usage }),
    }),
  );
  return [...body, "[DONE]"].map((data) => `data: ${data}\n\n`).join("");
}

/**
 * A local chat completions server that answers each request with the next of `replies`: a stream, or
 * "drop" to cut the connection after the first chunk. Returns the request bodies it received.
 */
async function server(replies: (Chunk[] | "drop")[]): Promise<{ url: string; requests: Record<string, unknown>[]; close: () => void }> {
  const requests: Record<string, unknown>[] = [];
  const http = createServer((req, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const reply = replies[requests.length - 1] ?? replies.at(-1)!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (reply === "drop") {
        res.write(sse([{ delta: { content: "Hel" } }]).split("data: [DONE]")[0]);
        setTimeout(() => res.socket?.destroy(), 20);
      } else {
        res.end(sse(reply));
      }
    });
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    requests,
    close() {
      http.closeAllConnections();
      http.close();
    },
  };
}

const hello: Chunk[] = [{ delta: { role: "assistant", content: "Hel" } }, { delta: { content: "lo" } }, { delta: {}, finish: "stop" }, { usage: { prompt_tokens: 50, completion_tokens: 2 } }];

/** Runs `work`, collecting the notices it prints that contain `marker`. */
async function capturing<T>(marker: string, work: () => Promise<T>): Promise<{ result: T; notices: string[] }> {
  const { notices, stop } = collectNotices(marker);
  try {
    return { result: await work(), notices };
  } finally {
    stop();
  }
}

const options = (url: string, more: Partial<ModelOptions> = {}): ModelOptions => ({
  model: "test-model",
  api: "openai",
  baseURL: url,
  quiet: true,
  system: "You are a test.",
  tools: TOOLS.filter((tool) => tool.definition.name === "bash"),
  ...more,
});

describe("the conversation as chat messages", () => {
  it("puts thinking back as reasoning_content, and each tool result right after its call", () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: "Count the files." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Use ls.", signature: "" },
          { type: "text", text: "Counting." },
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls | wc -l" } },
          { type: "tool_use", id: "call_2", name: "bash", input: { command: "false" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "3\n\nExit code: 0" },
          { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "Exit code: 1" }], is_error: true },
          { type: "text", text: "(Note from jig: the user undid your changes.)" },
        ],
      },
    ];
    assert.deepEqual(toChatMessages("Be brief.", history), [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Count the files." },
      {
        role: "assistant",
        content: "Counting.",
        reasoning_content: "Use ls.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls | wc -l"}' } },
          { id: "call_2", type: "function", function: { name: "bash", arguments: '{"command":"false"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "3\n\nExit code: 0" },
      { role: "tool", tool_call_id: "call_2", content: "Error: Exit code: 1" },
      { role: "user", content: "(Note from jig: the user undid your changes.)" },
    ]);
  });

  it("declares the tools as functions with their schemas", () => {
    const [bash] = toChatTools(TOOLS.filter((tool) => tool.definition.name === "bash"));
    assert.equal(bash.type, "function");
    assert.equal(bash.function.name, "bash");
    assert.deepEqual(bash.function.parameters, TOOLS.find((tool) => tool.definition.name === "bash")!.definition.input_schema);
  });
});

describe("a chat completions reply", () => {
  it("comes back as a Messages API reply: thinking, text and tool calls, with usage", async () => {
    const api = await server([
      [
        { delta: { role: "assistant", reasoning_content: "Two " } },
        { delta: { reasoning_content: "calls." } },
        { delta: { content: "On it." } },
        { delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "bash", arguments: '{"comm' } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } },
        { delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] } },
        { delta: {}, finish: "tool_calls" },
        { usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 900 } } },
      ],
    ]);
    try {
      const { message, malformed, offered } = await createModel(options(api.url))([{ role: "user", content: "hi" }]);
      assert.deepEqual(offered, ["bash"]); // what the request declared, for the loop to run only those
      assert.deepEqual(message.content, [
        { type: "thinking", thinking: "Two calls.", signature: "" },
        { type: "text", text: "On it.", citations: null },
        { type: "tool_use", id: "call_a", name: "bash", input: { command: "ls" } },
        { type: "tool_use", id: "call_b", name: "bash", input: { command: "pwd" } },
      ]);
      assert.equal(message.stop_reason, "tool_use");
      assert.deepEqual(message.usage, { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 40 });
      assert.equal(malformed.size, 0);
    } finally {
      api.close();
    }
  });

  it("sends the history, tools, effort and stream options; summarizing, it forbids tool calls", async () => {
    const api = await server([hello]);
    try {
      const callModel = createModel(options(api.url, { effort: "high" }));
      await callModel([{ role: "user", content: "hi" }]);
      await callModel([{ role: "user", content: "sum up" }], undefined, { summarize: true });
      const [first, second] = api.requests;
      assert.equal(first.model, "test-model");
      assert.equal(first.reasoning_effort, "high");
      assert.deepEqual(first.stream_options, { include_usage: true });
      assert.deepEqual((first.tools as { function: { name: string } }[]).map((tool) => tool.function.name), ["bash"]);
      assert.equal(first.tool_choice, undefined);
      assert.equal(second.tool_choice, "none");
      assert.deepEqual((first.messages as object[])[0], { role: "system", content: "You are a test." });
    } finally {
      api.close();
    }
  });

  it("asks DeepSeek for the output limit its Anthropic endpoint gets, and other servers for none", async () => {
    const api = await server([hello]);
    const key = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      await createModel(options(api.url, { model: "deepseek-flash" }))([{ role: "user", content: "hi" }]);
      await createModel(options(api.url))([{ role: "user", content: "hi" }]);
      assert.deepEqual(api.requests.map((request) => request.max_tokens), [64_000, undefined]);
    } finally {
      if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = key;
      api.close();
    }
  });

  it("flags tool input that isn't JSON, so the model hears about it", async () => {
    const api = await server([[{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "bash", arguments: '{"command": ls}' } }] } }, { delta: {}, finish: "tool_calls" }]]);
    try {
      const { message, malformed } = await createModel(options(api.url))([{ role: "user", content: "hi" }]);
      assert.deepEqual(message.content, [{ type: "tool_use", id: "call_x", name: "bash", input: {} }]);
      assert.equal(malformed.get("call_x"), '{"command": ls}');
    } finally {
      api.close();
    }
  });

  it("maps a reply cut off at the output limit to max_tokens", async () => {
    const api = await server([[{ delta: { content: "Long" } }, { delta: {}, finish: "length" }]]);
    try {
      assert.equal((await createModel(options(api.url))([{ role: "user", content: "hi" }])).message.stop_reason, "max_tokens");
    } finally {
      api.close();
    }
  });

  it("asks again when the stream ends early or the connection drops", async () => {
    const api = await server([[{ delta: { content: "Hel" } }], "drop", hello]);
    try {
      const { result, notices } = await capturing("broke off", () => createModel(options(api.url))([{ role: "user", content: "hi" }]));
      assert.deepEqual(result.message.content, [{ type: "text", text: "Hello", citations: null }]);
      assert.equal(notices.length, 2);
      assert.equal(api.requests.length, 3);
    } finally {
      api.close();
    }
  });

  it("times out and retries with a notice, as with the Messages API", async () => {
    const hung = createServer(() => {});
    await new Promise<void>((done) => hung.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/v1`;
      const { notices } = await capturing("trying again", () =>
        assert.rejects(createModel(options(url, { timeout: 100 }))([{ role: "user", content: "hi" }]), /timed out/i),
      );
      assert.equal(notices.length, 2);
      assert.match(notices[0], /The API didn't answer in time; trying again \(2 tries left\)/);
    } finally {
      hung.closeAllConnections();
      hung.close();
    }
  });
});

describe("choosing the API", () => {
  it("uses the Messages API for Claude and DeepSeek models, chat completions for others", () => {
    assert.equal(defaultApi("claude-opus-5-5"), "anthropic");
    assert.equal(defaultApi("deepseek-flash"), "anthropic");
    assert.equal(defaultApi("gpt-5"), "openai");
    assert.equal(defaultApi("qwen3-coder:30b"), "openai");
    assert.equal(contextWindow("qwen3-coder:30b"), 128_000);
    assert.equal(contextWindow("deepseek-flash"), 1_000_000);
  });

  it("refuses Claude through an OpenAI-compatible API", () => {
    assert.throws(() => createModel({ ...options("http://127.0.0.1:9/v1"), model: "claude-opus-5-5" }), /Anthropic API/);
  });
});

describe("the CLI on an OpenAI-compatible API", () => {
  it("talks chat completions to the server --base-url names, for a model that isn't Claude or DeepSeek", async () => {
    const api = await server([hello]);
    try {
      const project = await mkdtemp(join(tmpdir(), "jig-openai-"));
      const env = { ...process.env, JIG_HOME: await mkdtemp(join(tmpdir(), "jig-home-")), NO_COLOR: "1", OPENAI_API_KEY: "" };
      const cli = join(import.meta.dirname, "..", "src", "cli.ts");
      const child = spawn(process.execPath, [cli, "--no-sandbox", "--yes", "--model", "local-model", "--base-url", api.url, "Say hello."], { cwd: project, env });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const code = await new Promise<number | null>((done) => child.on("close", done));
      assert.equal(code, 0, output);
      assert.match(output, /Hello/);
      const [request] = api.requests as { model: string; messages: { role: string; content: string }[] }[];
      assert.equal(request.model, "local-model");
      assert.deepEqual(request.messages.at(-1), { role: "user", content: "Say hello." });
    } finally {
      api.close();
    }
  });
});
