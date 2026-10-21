import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in for the Messages API, for tests that run jig's CLI end to end.

/** A text block, or a tool call. Input given as a string is streamed as it is, so it can be malformed JSON. */
export type Block = { text: string } | { tool: string; input: object | string; id?: string };

/** A streamed Messages API reply made of text and tool calls; `stop` gives its stop reason, if not the usual one. */
export function messagesReply(blocks: Block[], stop?: string): string {
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
  stop ??= blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn";
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

/** A reply's blocks, or its blocks and the stop reason it ends with (a refusal, say). */
export type Reply = Block[] | { blocks: Block[]; stop: string };

/** A local Messages API that answers each request with what `answer` returns for it. */
export async function fakeMessagesApi(answer: (request: Record<string, unknown>) => Reply): Promise<FakeApi> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const reply = answer(request);
      res.end(Array.isArray(reply) ? messagesReply(reply) : messagesReply(reply.blocks, reply.stop));
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

// Runs a program at a pseudo-terminal no one types at, prints what it shows there, and exits as the program does.
const AT_A_TERMINAL = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    try:
        shown = os.read(fd, 65536)
    except OSError:  # Linux, once the program has exited
        shown = b""
    if not shown:
        break
    sys.stdout.buffer.write(shown)
    sys.stdout.buffer.flush()
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

/**
 * Runs jig's CLI against a fake API, in `cwd`, with its own JIG_HOME unless `env` gives one. With `terminal`,
 * its input and output are a pseudo-terminal that python3 makes and no one types at (`stdin` goes unread), and
 * the output comes without the terminal's escape codes and carriage returns. Still waiting for an answer after
 * 20 seconds, jig is hung up on, so a test fails rather than hangs.
 */
export async function runJig(
  args: string[],
  { api, cwd, env = {}, stdin = "", terminal = false }: { api: FakeApi; cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; terminal?: boolean },
): Promise<{ code: number | null; output: string }> {
  const home = env.JIG_HOME ?? (await mkdtemp(join(tmpdir(), "jig-home-")));
  const cli = join(import.meta.dirname, "..", "src", "cli.ts");
  const [program, ...rest] = terminal ? ["python3", "-c", AT_A_TERMINAL, process.execPath, cli, ...args] : [process.execPath, cli, ...args];
  const child = spawn(program, rest, {
    cwd,
    env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", NO_COLOR: "1", ...env, JIG_HOME: home },
    timeout: terminal ? 20_000 : undefined,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, output: terminal ? output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, "") : output };
}
