#!/usr/bin/env node
// The issue tracker's MCP server, so coding agents can read tickets. It speaks MCP's stdio transport:
// JSON-RPC 2.0 messages, one per line. The tickets come from the tracker's nightly export, bundled below.
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";

const EXPORT = `
H4sIAAAAAAAAE31UwW7bRhD9lYcFirQAzUoK3NbqKXBSoJfWSBvkEPmwIofiQssddmcomQh86ff0q/olwS5pWXad3sSd0Zs3b+bN
p89mT6NZm5v3v16/u1gufzSFUaeezNr80fIR2hKqIUYK1QgZuy17uIDKRgV11nkxhRG1OohZm8qzUG0KE6nnqBTN2nQ27kld2JnC
WBG3C5TQPQVrCrPlOtX/PdYUUXFoXOysOg4zOiSzYLVe4N2esFyViwWOTlseFPbErsQD4Q5W8O/f/+TM0hSm4q6joGLWnz4bO2jL
8ZFBbTXxWS1WP1wsri6WqyQB3alZm7ccKHWbRMh0oNT13irJzwisrQs7KKNqbdjlzD66yoVdae5v74vn4v50Ju51EnBuq+bwStGw
97PgMwp69q4azwXmnsJTeWXo0++n4g5h/qgfJX6DahDljiK2POxaBd3ZSv2I5SI1Q1vmvcCGGrWrE6MdaaazHfwetZOKh6AlPrbO
EzzzPnF0QRlOCzQu2FARGh5CDT0yOo6Eox1l2qJTx6hd01AUNJG7FxouN2ET/kzP+bOY8mb89SYsS6To5TdPmcH2vXckaSIW3gXC
saUAp4K/BhvU6QgnqV2OmVy5CasSb1Dx0HN4JegpVhTU7ggVdyTgpskEJ9620aTeeVEpIJzTjq3V2S6zzEcefI3ejqdtzeFcrMTH
B2OlEajdE5ye6nknmlUhKXBsXdVi5w4kJ3DJmNiytrDPdQh18kWuA2VGN1Rtgi434fWk3dSPE8Q0LaqTZpkcBZ2QW+tTvYf40OPb
RblcXWJLkzSLcvn6u2dt5OyHvyqDDhTyNG88WSE07g7We2gb6dwv36flKPvx62adp/9fv66uHv16Pd2P7MrT+sBu+UAlfpv9Sl4o
vc3jmD0obR7W5OSX7Xt1Zt9fEn9pXd8nSD5QxOUC7z68/3+zfuUWvmTXm8g9i/VoOCLQnaYdTjBrNE+Kp3iST85ppGM4x50kL+dd
qqdj5gRC8eAqwkiaFzg/BqJaYFFTIoPGRdESb/N1Ek325eSmZ0O6vb/9Asugl8xHBgAA`;
const tickets = JSON.parse(gunzipSync(Buffer.from(EXPORT.replace(/\s/g, ""), "base64")).toString());

const tools = [
  {
    name: "get_ticket",
    description: "Get a ticket by its key, like PRICE-101: its description, status and comments.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_tickets",
    description: "Find tickets whose title or description contains the words of the query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnlyHint: true },
  },
];

function format(ticket) {
  const comments = ticket.comments.map((c) => `- ${c.author} (${c.date}): ${c.text}`).join("\n") || "(none)";
  return `${ticket.key}: ${ticket.title}\nStatus: ${ticket.status} · Reporter: ${ticket.reporter} · Assignee: ${ticket.assignee}\n\n${ticket.body}\n\nComments:\n${comments}`;
}

function call(name, args) {
  if (name === "get_ticket") {
    const ticket = tickets.find((t) => t.key.toLowerCase() === String(args.key).trim().toLowerCase());
    return ticket ? { content: [{ type: "text", text: format(ticket) }] } : { content: [{ type: "text", text: `No ticket ${args.key}.` }], isError: true };
  }
  if (name === "search_tickets") {
    const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
    const found = tickets.filter((t) => words.every((w) => `${t.key} ${t.title} ${t.body}`.toLowerCase().includes(w)));
    return { content: [{ type: "text", text: found.map((t) => `${t.key} [${t.status}] ${t.title}`).join("\n") || "No tickets found." }] };
  }
  return { content: [{ type: "text", text: `Unknown tool ${name}.` }], isError: true };
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications need no answer
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    return reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tracker", version: "2.3.0" } });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools });
  if (method === "tools/call") return reply(call(params.name, params.arguments ?? {}));
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
});
