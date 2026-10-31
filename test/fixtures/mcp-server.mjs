// A minimal MCP server over stdio for jig's tests, written by hand rather than with the SDK, so the tests
// also check that jig's client speaks the protocol itself: newline-delimited JSON-RPC 2.0.
import { createInterface } from "node:readline";

const object = (properties = {}, required = []) => ({ type: "object", properties, required });
const tools = [
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: object({ a: { type: "number" }, b: { type: "number" } }, ["a", "b"]),
    annotations: { readOnlyHint: true },
  },
  { name: "fail", description: "Always fails.", inputSchema: object() },
  { name: "crash", description: "Makes the server exit.", inputSchema: object() },
  { name: "pid", description: "The server's process id.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "slow", description: "Answers after a second.", inputSchema: object() },
];
const PAGE = 2; // tools/list is paginated, to check that the client follows nextCursor

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // a notification, like notifications/initialized
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    return reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0.0" } });
  }
  if (method === "tools/list") {
    const start = Number(params?.cursor ?? 0);
    const next = start + PAGE < tools.length ? { nextCursor: String(start + PAGE) } : {};
    return reply({ tools: tools.slice(start, start + PAGE), ...next });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params;
    if (name === "add") return reply(text(args.a + args.b));
    if (name === "fail") return reply({ ...text(`the ${process.env.DATABASE ?? "database"} is locked`), isError: true }); // which server answered
    if (name === "crash") process.exit(1);
    if (name === "pid") return reply(text(process.pid));
    if (name === "slow") return void setTimeout(() => reply(text("done")), 1000);
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
});
