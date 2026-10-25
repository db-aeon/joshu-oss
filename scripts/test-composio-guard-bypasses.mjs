#!/usr/bin/env npx tsx
/**
 * Composio guard bypasses (change composio-guard-bypasses, issues #65, #66, #67):
 * - each inner tool call of COMPOSIO_MULTI_EXECUTE_TOOL gets the hard blocks and the action guard;
 * - the main Composio session has the workbench off; the workbench runs on the read session
 *   (read-only tools), and the guard routes workbench calls and read-only calls there;
 * - Hermes always calls Composio through the Composio MCP guard.
 *
 * The last part starts the real guard proxy against a fake Joshu API and two fake Composio MCP
 * servers (main session and read session).
 *
 * Usage: npm run test:composio-guard-bypasses
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { guardedComposioCalls } from "./lib/action-guard-classify.mjs";
import * as mjsPolicy from "./lib/mcp-tool-policy.mjs";
import * as tsPolicy from "../src/mcpToolPolicy.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const multi = (...tools) => ({ tools: tools.map(([tool_slug, args = {}]) => ({ tool_slug, arguments: args })) });
const calendarArgs = { calendar_id: "primary", summary: "Lunch", attendees: ["guest@example.com"] };
const externalPolicy = { enabled: true, gateMode: "external_writes", guardedActions: [], browserGateWrites: false };

// --- Hard blocks on inner tool calls (issue #65), same in the .mjs and the .ts copy
for (const policy of [mjsPolicy, tsPolicy]) {
  const enabled = { enabled: true, composioBlockedTools: [...policy.COMPOSIO_BLOCKED_TOOLS], connectorsBlockedTools: [] };
  const reason = (name, args) => policy.composioCallBlockReason(name, args, enabled);

  assert.match(reason("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["GMAIL_FETCH_EMAILS"], ["GMAIL_SEND_EMAIL"])), /Gmail mail send/);
  assert.match(reason("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["GMAIL_CREATE_EMAIL_DRAFT"])), /Gmail mail send/);
  assert.match(
    reason("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["COMPOSIO_MULTI_EXECUTE_TOOL", multi(["GOOGLECALENDAR_DELETE_EVENT"])])),
    /Delete\/trash/,
    "nested multi execute",
  );
  assert.equal(reason("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["GMAIL_FETCH_EMAILS"], ["GOOGLECALENDAR_EVENTS_LIST"])), null);
  assert.equal(reason("COMPOSIO_SEARCH_TOOLS", { queries: [] }), null);
  assert.match(reason("COMPOSIO_MULTI_EXECUTE_TOOL", {}), /needs a tools list/);
  assert.match(reason("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ arguments: {} }] }), /needs a tools list/);
  assert.equal(policy.composioCallBlockReason("COMPOSIO_MULTI_EXECUTE_TOOL", {}, { ...enabled, enabled: false }), null);

  // Composio workbench (issue #66): no hard block, because it runs on the read session only
  assert.equal(reason("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "x" }), null);
  assert.equal(reason("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["COMPOSIO_REMOTE_BASH_TOOL"])), null);

  assert.deepEqual(
    policy.composioInnerToolCalls("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["GMAIL_FETCH_EMAILS", { query: "x" }])),
    [{ toolName: "GMAIL_FETCH_EMAILS", args: { query: "x" } }],
  );
}
assert.deepEqual([...tsPolicy.COMPOSIO_BLOCKED_TOOLS], mjsPolicy.COMPOSIO_BLOCKED_TOOLS, ".mjs and .ts lists match");

// --- Action guard on inner tool calls (issue #65)
{
  const gated = guardedComposioCalls(
    "COMPOSIO_MULTI_EXECUTE_TOOL",
    multi(["GMAIL_FETCH_EMAILS"], ["GOOGLECALENDAR_CREATE_EVENT", calendarArgs]),
    externalPolicy,
  );
  assert.deepEqual(gated, [{ toolName: "GOOGLECALENDAR_CREATE_EVENT", args: calendarArgs }]);
  assert.deepEqual(
    guardedComposioCalls("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["GMAIL_FETCH_EMAILS"]), externalPolicy),
    [],
  );
  assert.deepEqual(
    guardedComposioCalls("COMPOSIO_MULTI_EXECUTE_TOOL", multi(["GOOGLECALENDAR_PATCH_EVENT"]), { ...externalPolicy, enabled: false }),
    [],
  );
  assert.equal(guardedComposioCalls("GOOGLECALENDAR_CREATE_EVENT", calendarArgs, externalPolicy).length, 1);
}

// --- The main session has the workbench off; the read session has read-only tools and the workbench on (issue #66)
{
  const { createSessionConfig, createReadSessionConfig } = await import("../src/composioApi.ts");
  assert.equal(createSessionConfig({}).workbench.enable, false);
  const read = createReadSessionConfig({ gmail: "ac_1" });
  assert.deepEqual(read.tags, ["readOnlyHint"]);
  assert.deepEqual(read.workbench, { enable: true, enableProxyExecution: false });
  assert.equal(read.manageConnections.enable, false);
  assert.deepEqual(read.authConfigs, { gmail: "ac_1" });
  assert.equal("tools" in read || "toolkits" in read, false, "a per-toolkit list would skip the tag filter");
}

// --- Hermes uses the Composio MCP guard also with the action guard off (issue #67)
{
  const home = await mkdtemp(path.join(tmpdir(), "joshu-hermes-home-"));
  process.env.HERMES_HOME = home;
  process.env.JOSHU_ACTION_GUARD_ENABLED = "false";
  try {
    const { applyComposioMcpToHermesConfig } = await import("../src/hermesApi.ts");
    await applyComposioMcpToHermesConfig({
      url: "https://backend.composio.dev/tool_router/trs_test/mcp",
      headers: { "x-api-key": "test-key" },
      type: "streamable_http",
      enabled: true,
    });
    const yaml = await readFile(path.join(home, "config.yaml"), "utf8");
    const composio = yaml.slice(yaml.indexOf("composio:"));
    assert.match(composio, /url: http:\/\/127\.0\.0\.1:8796\/mcp/);
    assert.match(composio, /connect_timeout: 120/);
    assert.doesNotMatch(yaml, /backend\.composio\.dev|test-key/, "no Composio URL or key in the Hermes configuration");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// --- The guard proxy itself, against a fake Joshu API and a fake Composio MCP server
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** Tool calls that reached the fake Composio MCP servers, with the session that ran each one. */
const upstreamCalls = [];
const upstreamTools = ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_SEARCH_TOOLS"];
/** The fake read session refuses tools that are not read-only, like Composio does. */
const readOnlyOnComposio = (slug) => slug !== "GMAIL_GET_TRICKY" && !/SEND|CREATE|DELETE/.test(slug);
const upstreamApp = createMcpExpressApp({ host: "127.0.0.1" });
upstreamApp.post("/:session/mcp", async (req, res) => {
  const session = req.params.session;
  const server = new Server({ name: "fake-composio", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: upstreamTools.map((name) => ({ name, inputSchema: { type: "object" } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    upstreamCalls.push({ session, name: request.params.name });
    const slugs = (request.params.arguments?.tools ?? []).map((t) => t.tool_slug);
    if (session === "read" && slugs.some((slug) => !readOnlyOnComposio(slug))) {
      const text = JSON.stringify({ data: { results: [{ error: "[Session Restriction] Tool is blocked for this session" }] } });
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { ran: request.params.name } }) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
const upstreamHttp = createServer(upstreamApp);
const upstreamPort = await listen(upstreamHttp);
const sessionsOf = (from) => upstreamCalls.slice(from).map((c) => c.session);

/** Approval requests that reached the fake Joshu API, and the decision it returns. */
const approvals = [];
let decision = "denied";
let hasReadSession = true;
const joshuHttp = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (json) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  };
  if (req.url === "/joshu/api/connectors/composio/mcp-upstream") {
    return send({
      mcp: { url: `http://127.0.0.1:${upstreamPort}/main/mcp`, headers: {} },
      readMcp: hasReadSession ? { url: `http://127.0.0.1:${upstreamPort}/read/mcp`, headers: {} } : null,
    });
  }
  if (req.url === "/joshu/api/mcp-tool-policy") {
    return send({ policy: { enabled: true, composioBlockedTools: [...tsPolicy.COMPOSIO_BLOCKED_TOOLS], connectorsBlockedTools: [] } });
  }
  if (req.url === "/joshu/api/action-guard/status") {
    return send({ enabled: true, policy: externalPolicy });
  }
  if (req.url === "/joshu/api/owner-channel/await") {
    approvals.push(JSON.parse(body));
    return send({ decision });
  }
  res.writeHead(404);
  res.end();
});
const joshuPort = await listen(joshuHttp);

const probe = createServer();
const guardPort = await listen(probe);
await new Promise((resolve) => probe.close(resolve));

const guard = spawn(process.execPath, [path.join(root, "scripts/composio-mcp-guard-proxy.mjs")], {
  env: {
    ...process.env,
    JOSHU_COMPOSIO_MCP_GUARD_PORT: String(guardPort),
    JOSHU_CONNECTORS_API_BASE: `http://127.0.0.1:${joshuPort}/joshu`,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let guardLog = "";
guard.stderr.on("data", (chunk) => {
  guardLog += chunk;
});

try {
  for (let i = 0; i < 50; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${guardPort}/health`).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${guardPort}/mcp`)));

  const listed = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(
    listed.sort(),
    ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_SEARCH_TOOLS"],
    "workbench tools listed once, from the read session",
  );

  // Gmail send inside multi execute: refused, no approval request, nothing upstream
  let result = await client.callTool({
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    arguments: multi(["GMAIL_FETCH_EMAILS"], ["GMAIL_SEND_EMAIL", { recipient_email: "x@example.com" }]),
  });
  assert.equal(result.isError, true);
  assert.equal(approvals.length, 0);
  assert.equal(upstreamCalls.length, 0);

  // Workbench calls run on the read session with no approval request
  result = await client.callTool({ name: "COMPOSIO_REMOTE_BASH_TOOL", arguments: { command: "ls" } });
  assert.notEqual(result.isError, true);
  await client.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: multi(["COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "x" }]) });
  assert.deepEqual(sessionsOf(0), ["read", "read"]);
  assert.equal(approvals.length, 0);

  // Calendar create inside multi execute, owner denies: one approval request with the inner arguments, nothing upstream
  let from = upstreamCalls.length;
  result = await client.callTool({
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    arguments: multi(["GMAIL_FETCH_EMAILS"], ["GOOGLECALENDAR_CREATE_EVENT", calendarArgs]),
  });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].actionId, "composio:GOOGLECALENDAR_CREATE_EVENT");
  assert.equal(approvals[0].summary.subject, "Lunch");
  assert.deepEqual(sessionsOf(from), [], "a denial runs no inner tool call");
  const stub = JSON.parse(result.content[0].text);
  assert.deepEqual(stub.data.results.map((r) => r.tool_slug), ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_CREATE_EVENT"]);

  // Owner approves: the write runs on the main session
  decision = "approved";
  from = upstreamCalls.length;
  await client.callTool({
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    arguments: multi(["GOOGLECALENDAR_CREATE_EVENT", calendarArgs]),
  });
  assert.equal(approvals.length, 2);
  assert.deepEqual(sessionsOf(from), ["main"]);

  // Reads only: no approval request, read session
  from = upstreamCalls.length;
  await client.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: multi(["GMAIL_FETCH_EMAILS"]) });
  assert.equal(approvals.length, 2);
  assert.deepEqual(sessionsOf(from), ["read"]);

  // A name that reads as a read, but Composio refuses it on the read session: the call runs again on the main session
  from = upstreamCalls.length;
  result = await client.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: multi(["GMAIL_GET_TRICKY"]) });
  assert.deepEqual(sessionsOf(from), ["read", "main"]);
  assert.match(result.content[0].text, /"ran"/);

  // Other tools run on the main session
  from = upstreamCalls.length;
  await client.callTool({ name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [] } });
  assert.deepEqual(sessionsOf(from), ["main"]);

  // No read session yet: the workbench is not offered and its calls are refused; reads run on the main session
  hasReadSession = false;
  await fetch(`http://127.0.0.1:${guardPort}/reset-upstream`, { method: "POST" });
  const listedWithoutRead = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(listedWithoutRead.sort(), ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_SEARCH_TOOLS"]);
  from = upstreamCalls.length;
  result = await client.callTool({ name: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: "x" } });
  assert.equal(result.isError, true);
  await client.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: multi(["GMAIL_FETCH_EMAILS"]) });
  assert.deepEqual(sessionsOf(from), ["main"]);

  await client.close();
} catch (err) {
  console.error(guardLog);
  throw err;
} finally {
  guard.kill();
  upstreamHttp.close();
  joshuHttp.close();
}

console.log("composio-guard-bypasses: ok");
