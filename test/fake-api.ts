import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in for the Messages API, for tests that run jig's CLI end to end.

/** A text block, or a tool call. Input given as a string is streamed as it is, so it can be malformed JSON. */
export type Block = { text: string } | { tool: string; input: object | string; id?: string };

/** A streamed Messages API reply made of text and tool calls. */
export function messagesReply(blocks: Block[]): string {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let body = event("message_start", { message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if ("text" in block) {
      body += event("content_block_start", { index, content_block: { type: "text", text: "" } });
      body += event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      body += event("content_block_start", { index, content_block: { type: "tool_use", id: block.id ?? `call_${index}_${block.tool}`, name: block.tool, input: {} } });
      body += event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: typeof block.input === "string" ? block.input : JSON.stringify(block.input) } });
    }
    body += event("content_block_stop", { index });
  });
  const stop = blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn";
  return body + event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }) + event("message_stop", {});
}

/** The system prompt of a request, as text. */
export function systemText(request: { system?: string | { text: string }[] }): string {
  return typeof request.system === "string" ? request.system : (request.system ?? []).map((block) => block.text).join("");
}

export interface FakeApi {
  url: string;
  requests: Record<string, unknown>[];
  close(): void;
}

/** A local Messages API that answers each request with what `answer` returns for it. */
export async function fakeMessagesApi(answer: (request: Record<string, unknown>) => Block[]): Promise<FakeApi> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(messagesReply(answer(request)));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Runs jig's CLI against a fake API, in `cwd`, with its own JIG_HOME unless `env` gives one. */
export async function runJig(args: string[], { api, cwd, env = {}, stdin = "" }: { api: FakeApi; cwd: string; env?: NodeJS.ProcessEnv; stdin?: string }): Promise<{ code: number | null; output: string }> {
  const home = env.JIG_HOME ?? (await mkdtemp(join(tmpdir(), "jig-home-")));
  const cli = join(import.meta.dirname, "..", "src", "cli.ts");
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", NO_COLOR: "1", ...env, JIG_HOME: home },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, output };
}
