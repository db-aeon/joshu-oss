#!/usr/bin/env node
/**
 * Gated pass-through proxy for Composio MCP — Hermes connects here, not Composio cloud,
 * also when the action guard is off. Hard blocks (mcp-tool-policy) apply always; write tools
 * need owner approval when the action guard is on. Both rules apply to each inner tool call
 * of COMPOSIO_MULTI_EXECUTE_TOOL.
 *
 * Two upstream Composio sessions: the main session (workbench off) and the read session
 * (read-only tools, workbench on). The workbench tools, and a multi execute call whose inner
 * tool calls all read, run on the read session, so a large result lands in the sandbox that
 * the workbench can read. Composio refuses each write on the read session; the guard then runs
 * the call again on the main session.
 *
 * Env: JOSHU_COMPOSIO_MCP_GUARD_PORT (8796), JOSHU_CONNECTORS_API_BASE
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  actionGuardPolicyFromStatus,
  buildComposioToolSummary,
  guardedComposioCalls,
  isComposioReadTool,
} from "./lib/action-guard-classify.mjs";
import {
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_WORKBENCH_TOOLS,
  composioCallBlockReason,
  composioInnerToolCalls,
  composioToolBlockReason,
  defaultMcpToolPolicy,
  mcpToolPolicyFromApi,
} from "./lib/mcp-tool-policy.mjs";

const PORT = Number.parseInt(process.env.JOSHU_COMPOSIO_MCP_GUARD_PORT || "8796", 10);
const HOST = process.env.JOSHU_COMPOSIO_MCP_GUARD_HOST?.trim() || "127.0.0.1";
const JOSHU_BASE = (process.env.JOSHU_CONNECTORS_API_BASE || "http://127.0.0.1:8788/joshu").replace(/\/+$/, "");
/** Read the policies again after this time, so a change in the Safety app applies with no restart. */
const POLICY_CACHE_MS = 30_000;

/** @type {Map<string, { transport: StreamableHTTPServerTransport; server: Server }>} */
const sessions = new Map();

/** @type {Promise<Client> | null} */
let upstreamClientPromise = null;
/** @type {Promise<Client | null> | null} */
let readUpstreamClientPromise = null;
/** @type {{ at: number; value: import("./lib/action-guard-classify.mjs").ActionGuardPolicySlice } | null} */
let cachedActionGuardPolicy = null;
/** @type {{ at: number; value: import("./lib/mcp-tool-policy.mjs").McpToolPolicy } | null} */
let cachedMcpToolPolicy = null;

function isFresh(cached) {
  return cached !== null && Date.now() - cached.at < POLICY_CACHE_MS;
}

function log(msg) {
  process.stderr.write(`[composio-mcp-guard] ${msg}\n`);
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function fetchJson(path) {
  const res = await fetch(`${JOSHU_BASE}${path}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(json.error || json.raw || `HTTP ${res.status} ${path}`);
  }
  return json;
}

async function loadActionGuardPolicy() {
  if (isFresh(cachedActionGuardPolicy)) return cachedActionGuardPolicy.value;
  let value;
  try {
    const status = await fetchJson("/api/action-guard/status");
    value = actionGuardPolicyFromStatus(status);
    if (status.enabled === true) {
      value.enabled = true;
    }
  } catch {
    value = { enabled: false, gateMode: "external_writes", guardedActions: [], browserGateWrites: false };
  }
  cachedActionGuardPolicy = { at: Date.now(), value };
  return value;
}

async function loadMcpToolPolicy() {
  if (isFresh(cachedMcpToolPolicy)) return cachedMcpToolPolicy.value;
  let value;
  try {
    const payload = await fetchJson("/api/mcp-tool-policy");
    value = mcpToolPolicyFromApi(payload);
  } catch {
    value = defaultMcpToolPolicy();
  }
  cachedMcpToolPolicy = { at: Date.now(), value };
  return value;
}

function stubComposioToolResponse(toolName, args) {
  const a = args && typeof args === "object" ? args : {};
  const name = toolName.trim().toUpperCase();
  if (name.includes("SEND") || name.includes("REPLY")) {
    return {
      successful: true,
      data: {
        id: `blocked-${randomUUID()}`,
        messageId: `blocked-${randomUUID()}`,
        recipient_email: readString(a.recipient_email) || readString(a.to),
      },
    };
  }
  if (name.includes("CALENDAR") || name.includes("EVENT")) {
    return {
      successful: true,
      data: {
        id: `blocked-${randomUUID()}`,
        event_id: `blocked-${randomUUID()}`,
        htmlLink: "",
      },
    };
  }
  if (name.includes("SLACK")) {
    return {
      successful: true,
      data: {
        ok: true,
        ts: `${Date.now()}.000000`,
        channel: readString(a.channel) || readString(a.channel_id),
      },
    };
  }
  return { successful: true, data: { id: `blocked-${randomUUID()}` } };
}

/** Stub for a denied COMPOSIO_MULTI_EXECUTE_TOOL call: one stub result for each inner tool call. */
function stubComposioCallResponse(toolName, args) {
  const calls = composioInnerToolCalls(toolName, args) ?? [];
  if (calls.length === 1 && calls[0].toolName === toolName.trim()) {
    return stubComposioToolResponse(toolName, args);
  }
  return {
    successful: true,
    data: {
      results: calls.map((call) => ({
        tool_slug: call.toolName,
        response: stubComposioToolResponse(call.toolName, call.args),
      })),
    },
  };
}

async function actionGuardAwait(actionId, summary) {
  const res = await fetch(`${JOSHU_BASE}/api/owner-channel/await`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId, summary }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(json.error || json.raw || `action guard HTTP ${res.status}`);
  }
  return json;
}

async function connectUpstream(mcp, label) {
  const headers = mcp.headers && typeof mcp.headers === "object" ? mcp.headers : {};
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers },
  });
  const client = new Client(
    { name: "composio-guard-upstream", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  log(`upstream ${label} connected ${mcp.url}`);
  return client;
}

async function getUpstreamClient() {
  if (!upstreamClientPromise) {
    upstreamClientPromise = (async () => {
      const payload = await fetchJson("/api/connectors/composio/mcp-upstream");
      if (!payload.mcp?.url) throw new Error("Composio upstream MCP URL missing");
      return connectUpstream(payload.mcp, "main");
    })().catch((err) => {
      upstreamClientPromise = null;
      throw err;
    });
  }
  return upstreamClientPromise;
}

/** The read session client, or null while the Joshu API has no read session (asked again next time). */
async function getReadUpstreamClient() {
  if (!readUpstreamClientPromise) {
    readUpstreamClientPromise = (async () => {
      const payload = await fetchJson("/api/connectors/composio/mcp-upstream");
      if (!payload.readMcp?.url) return null;
      return connectUpstream(payload.readMcp, "read");
    })().then(
      (client) => {
        if (!client) readUpstreamClientPromise = null;
        return client;
      },
      (err) => {
        readUpstreamClientPromise = null;
        throw err;
      },
    );
  }
  return readUpstreamClientPromise;
}

function resetUpstreamClient() {
  upstreamClientPromise = null;
  readUpstreamClientPromise = null;
  cachedActionGuardPolicy = null;
  cachedMcpToolPolicy = null;
}

function isWorkbenchTool(name) {
  return COMPOSIO_WORKBENCH_TOOLS.includes(String(name ?? "").trim().toUpperCase());
}

/** The workbench tools, and a multi execute call whose inner tool calls all read by name. */
function runsOnReadSession(name, args) {
  if (isWorkbenchTool(name)) return true;
  if (String(name ?? "").trim().toUpperCase() !== COMPOSIO_MULTI_EXECUTE_TOOL) return false;
  const calls = composioInnerToolCalls(name, args);
  return Boolean(calls?.length) && calls.every((call) => isComposioReadTool(call.toolName));
}

/** True when Composio refused a tool of the call because the read session has only read-only tools. */
function isReadSessionRefusal(result) {
  return JSON.stringify(result?.content ?? result ?? "").includes("[Session Restriction]");
}

function formatBlockedToolResult(reason) {
  return {
    content: [{ type: "text", text: reason }],
    isError: true,
  };
}

function formatToolResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

async function createMcpServer() {
  const server = new Server(
    { name: "composio-mcp-guard-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = await getUpstreamClient();
    const policy = await loadMcpToolPolicy();
    const result = await client.listTools();
    let tools = (result.tools ?? []).filter((t) => !isWorkbenchTool(t.name));
    try {
      const readClient = await getReadUpstreamClient();
      if (readClient) {
        const readResult = await readClient.listTools();
        tools = tools.concat((readResult.tools ?? []).filter((t) => isWorkbenchTool(t.name)));
      }
    } catch (err) {
      readUpstreamClientPromise = null;
      log(`read session tools unavailable: ${err instanceof Error ? err.message : err}`);
    }
    return { tools: tools.filter((t) => !composioToolBlockReason(t.name, policy)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const policy = await loadMcpToolPolicy();
    const blockReason = composioCallBlockReason(name, args, policy);
    if (blockReason) {
      log(`blocked tool ${name}: ${blockReason}`);
      return formatBlockedToolResult(blockReason);
    }

    const guardPolicy = await loadActionGuardPolicy();

    // One approval for each gated inner tool call; one denial stops the whole call.
    for (const call of guardedComposioCalls(name, args, guardPolicy)) {
      const actionId = `composio:${call.toolName}`;
      const summary = buildComposioToolSummary(call.toolName, call.args);
      const guard = await actionGuardAwait(actionId, summary);
      if (guard.decision === "denied" || guard.decision === "timeout") {
        return formatToolResult(stubComposioCallResponse(name, args));
      }
    }

    try {
      let result = null;
      if (runsOnReadSession(name, args)) {
        const readClient = await getReadUpstreamClient();
        if (readClient) {
          result = await readClient.callTool({ name, arguments: args });
          if (!isWorkbenchTool(name) && isReadSessionRefusal(result)) result = null;
        } else if (isWorkbenchTool(name)) {
          return formatBlockedToolResult("The Composio workbench is not ready on this box yet. Try again in a few minutes.");
        }
      }
      if (!result) {
        const client = await getUpstreamClient();
        result = await client.callTool({ name, arguments: args });
      }
      if (result.content) return result;
      return formatToolResult(result.structuredContent ?? result);
    } catch (err) {
      resetUpstreamClient();
      throw err;
    }
  });

  return server;
}

async function main() {
  const app = createMcpExpressApp({ host: HOST });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "composio-mcp-guard" });
  });

  app.post("/reset-upstream", (_req, res) => {
    resetUpstreamClient();
    res.json({ ok: true });
  });

  app.all("/mcp", async (req, res) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

    try {
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && req.method === "POST") {
        const body = req.body;
        const messages = Array.isArray(body) ? body : body ? [body] : [];
        const isInit = messages.some((m) => isInitializeRequest(m));
        if (isInit) {
          /** @type {{ transport: StreamableHTTPServerTransport; server: Server } | undefined} */
          let sessionEntry;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              if (sessionEntry) sessions.set(sid, sessionEntry);
              log(`MCP session ${sid} initialized`);
            },
            onsessionclosed: (sid) => {
              sessions.delete(sid);
            },
          });
          const server = await createMcpServer();
          sessionEntry = { transport, server };
          await server.connect(transport);
          session = sessionEntry;
        }
      }

      if (!session) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid MCP session" },
          id: null,
        });
        return;
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`MCP error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  app.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}/mcp (Joshu ${JOSHU_BASE})`);
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
