import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { McpServerConfig } from "./settings.ts";
import type { Tool, ToolInput } from "./tools/index.ts";
import { VERSION } from "./version.ts";

const CONNECT_TIMEOUT = 30_000;
const CALL_TIMEOUT = 300_000;
const MAX_NAME = 64; // the longest tool name the APIs take

export interface McpServers {
  tools: Tool[];
  /** For the user: how many tools each server brought. */
  status: string[];
  /** For the user: the servers that failed to start, and why, and the tools whose names clashed. */
  errors: string[];
  /** The tools whose names have a hash added: the name they would have shared, and their server. */
  renamed: Map<string, { was: string; server: string }>;
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
  const found: Found[] = [];
  const status: string[] = [];
  const errors: string[] = [];
  await Promise.all(
    connections.map(async (server) => {
      try {
        const client = await server.client();
        const listed: McpTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT });
          listed.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        found.push(...listed.map((tool) => ({ server, tool })));
        status.push(`MCP server "${server.name}": ${listed.length} tool${listed.length === 1 ? "" : "s"}`);
      } catch (err) {
        await server.close();
        errors.push(`The MCP server "${server.name}" failed to start: ${(err as Error).message}`);
      }
    }),
  );
  found.sort((a, b) => connections.indexOf(a.server) - connections.indexOf(b.server)); // the settings' order, not the order they answered in
  const { tools, renamed, clashes } = named(found);
  errors.push(...clashes);
  return { tools, status, errors, renamed, close: async () => void (await Promise.allSettled(connections.map((server) => server.close()))) };
}

type Found = { server: Connection; tool: McpTool };

/**
 * The servers' tools as jig tools. A name takes only letters, digits, _ and -, up to 64 characters, so two
 * tools can come out with the same one: servers "db.prod" and "db prod" both become db_prod. The model
 * calls a tool by its name, so each of those gets a hash of its exact server and tool names added; a name
 * no other tool has stays as it is.
 */
function named(found: Found[]) {
  const plain = found.map(({ server, tool }) => `mcp__${server.name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_NAME));
  const renamed: McpServers["renamed"] = new Map();
  const clashes = new Set<string>(); // for the user: one line for each set of servers
  const tools = found.map(({ server, tool }, i) => {
    if (plain.indexOf(plain[i]) === plain.lastIndexOf(plain[i])) return wrap(server, tool, plain[i]);
    const name = `${plain[i].slice(0, MAX_NAME - 9)}_${createHash("sha256").update(`${server.name}\0${tool.name}`).digest("hex").slice(0, 8)}`;
    renamed.set(name, { was: plain[i], server: server.name });
    const servers = [...new Set(found.filter((_, j) => plain[j] === plain[i]).map((other) => `"${other.server.name}"`))];
    clashes.add(`Tools of the MCP ${servers.length === 1 ? "server" : "servers"} ${servers.join(" and ")} come out with the same names, so each has a short hash added (/mcp lists them).`);
    return wrap(server, tool, name, true);
  });
  return { tools, renamed, clashes };
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

/** A tool whose name has a hash added says where it is from, since the name no longer tells the model. */
function wrap(server: Connection, tool: McpTool, name: string, hashed = false): Tool {
  const description = tool.description ?? `The ${tool.name} tool of the ${server.name} MCP server.`;
  return {
    definition: {
      name,
      description: hashed ? `${description}\n\n(The "${tool.name}" tool of the MCP server "${server.name}".)` : description,
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
