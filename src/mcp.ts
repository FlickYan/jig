import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { McpServerConfig } from "./settings.ts";
import type { Tool, ToolInput } from "./tools/index.ts";
import { VERSION } from "./version.ts";

const CONNECT_TIMEOUT = 30_000;
const CALL_TIMEOUT = 300_000;

export interface McpServers {
  tools: Tool[];
  /** For the user: how many tools each server brought. */
  status: string[];
  /** For the user: the servers that failed to start, and why. */
  errors: string[];
  close(): Promise<void>;
}

/**
 * Starts the configured MCP servers (as child processes speaking JSON-RPC over stdio, with the official
 * SDK) and turns their tools into jig tools named mcp__<server>__<tool>, as Claude Code names them. A
 * server that fails to start is reported and skipped. Servers run outside the sandbox: they are programs
 * the user chose to run.
 */
export async function connectMcpServers(servers: Record<string, McpServerConfig>, cwd: string): Promise<McpServers> {
  const connections = Object.entries(servers).map(([name, config]) => connection(name, config, cwd));
  const tools: Tool[] = [];
  const status: string[] = [];
  const errors: string[] = [];
  await Promise.all(
    connections.map(async (server) => {
      try {
        const client = await server.client();
        const found: McpTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT });
          found.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        tools.push(...found.map((tool) => wrap(server, tool)));
        status.push(`MCP server "${server.name}": ${found.length} tool${found.length === 1 ? "" : "s"}`);
      } catch (err) {
        await server.close();
        errors.push(`The MCP server "${server.name}" failed to start: ${(err as Error).message}`);
      }
    }),
  );
  return { tools, status, errors, close: async () => void (await Promise.allSettled(connections.map((server) => server.close()))) };
}

type Connection = ReturnType<typeof connection>;

/**
 * One server. If it stops, the next call starts it again: servers crash, and Ctrl+C in the terminal
 * reaches them too, since they are in jig's process group.
 */
function connection(name: string, config: McpServerConfig, cwd: string) {
  let current: Client | undefined;
  return {
    name,
    async client(): Promise<Client> {
      if (current?.transport) return current; // the SDK drops the transport when the server exits
      current = new Client({ name: "jig", version: VERSION });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...getDefaultEnvironment(), ...config.env },
        cwd,
        stderr: "ignore",
      });
      await current.connect(transport, { timeout: CONNECT_TIMEOUT });
      return current;
    },
    close: async () => void (await current?.close().catch(() => {})),
  };
}

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

function wrap(server: Connection, tool: McpTool): Tool {
  return {
    definition: {
      name: `mcp__${server.name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      description: tool.description ?? `The ${tool.name} tool of the ${server.name} MCP server.`,
      input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    },
    // The server can say a tool only reads; anything else may act in the world, so it needs approval.
    kind: tool.annotations?.readOnlyHint ? "read" : "external",
    describe: (input) => clip(JSON.stringify(input)),
    async run(input: ToolInput, { signal }) {
      const client = await server.client();
      const result = await client.callTool({ name: tool.name, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT });
      const text = toText(result);
      if (result.isError) throw new Error(text);
      return text;
    },
  };
}

/** An MCP tool result as text for the model. */
function toText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result.content ?? []) as Array<Record<string, unknown> & { type: string }>;
  const parts = content.map((part) => {
    if (part.type === "text") return String(part.text);
    if (part.type === "resource") {
      const resource = part.resource as { uri: string; text?: string };
      return resource.text ?? `[resource ${resource.uri}]`;
    }
    if (part.type === "resource_link") return `[resource ${part.uri}]`;
    if (part.type === "image" || part.type === "audio") return `[${part.type}: ${part.mimeType}]`;
    return `[${part.type}]`;
  });
  if (parts.length === 0 && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join("\n") || "(no output)";
}

function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
