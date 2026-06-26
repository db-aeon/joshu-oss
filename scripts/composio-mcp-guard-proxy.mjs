#!/usr/bin/env node
/**
 * Gated pass-through proxy for Composio MCP — Hermes connects here, not Composio cloud.
 * Write tools require owner Telegram approval via Joshu action guard.
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
  isGuardedComposioTool,
} from "./lib/action-guard-classify.mjs";
import {
  composioToolBlockReason,
  defaultMcpToolPolicy,
  mcpToolPolicyFromApi,
} from "./lib/mcp-tool-policy.mjs";

const PORT = Number.parseInt(process.env.JOSHU_COMPOSIO_MCP_GUARD_PORT || "8796", 10);
const HOST = process.env.JOSHU_COMPOSIO_MCP_GUARD_HOST?.trim() || "127.0.0.1";
const JOSHU_BASE = (process.env.JOSHU_CONNECTORS_API_BASE || "http://127.0.0.1:8788/joshu").replace(/\/+$/, "");

/** @type {Map<string, { transport: StreamableHTTPServerTransport; server: Server }>} */
const sessions = new Map();

/** @type {Promise<Client> | null} */
let upstreamClientPromise = null;
/** @type {import("./lib/action-guard-classify.mjs").ActionGuardPolicySlice | null} */
let cachedActionGuardPolicy = null;
/** @type {import("./lib/mcp-tool-policy.mjs").McpToolPolicy | null} */
let cachedMcpToolPolicy = null;

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
  if (cachedActionGuardPolicy) return cachedActionGuardPolicy;
  try {
    const status = await fetchJson("/api/action-guard/status");
    cachedActionGuardPolicy = actionGuardPolicyFromStatus(status);
    if (status.enabled === true) {
      cachedActionGuardPolicy.enabled = true;
    }
  } catch {
    cachedActionGuardPolicy = { enabled: false, gateMode: "external_writes", guardedActions: [], browserGateWrites: false };
  }
  return cachedActionGuardPolicy;
}

async function loadMcpToolPolicy() {
  if (cachedMcpToolPolicy) return cachedMcpToolPolicy;
  try {
    const payload = await fetchJson("/api/mcp-tool-policy");
    cachedMcpToolPolicy = mcpToolPolicyFromApi(payload);
  } catch {
    cachedMcpToolPolicy = defaultMcpToolPolicy();
  }
  return cachedMcpToolPolicy;
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

async function getUpstreamClient() {
  if (!upstreamClientPromise) {
    upstreamClientPromise = (async () => {
      const payload = await fetchJson("/api/connectors/composio/mcp-upstream");
      const mcp = payload.mcp;
      if (!mcp?.url) throw new Error("Composio upstream MCP URL missing");
      const headers = mcp.headers && typeof mcp.headers === "object" ? mcp.headers : {};
      const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers },
      });
      const client = new Client(
        { name: "composio-guard-upstream", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      log(`upstream connected ${mcp.url}`);
      return client;
    })().catch((err) => {
      upstreamClientPromise = null;
      throw err;
    });
  }
  return upstreamClientPromise;
}

function resetUpstreamClient() {
  upstreamClientPromise = null;
  cachedActionGuardPolicy = null;
  cachedMcpToolPolicy = null;
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
    const tools = (result.tools ?? []).filter((t) => !composioToolBlockReason(t.name, policy));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const policy = await loadMcpToolPolicy();
    const blockReason = composioToolBlockReason(name, policy);
    if (blockReason) {
      log(`blocked tool ${name}: ${blockReason}`);
      return formatBlockedToolResult(blockReason);
    }

    const guardPolicy = await loadActionGuardPolicy();

    if (isGuardedComposioTool(name, guardPolicy)) {
      const actionId = `composio:${name.trim()}`;
      const summary = buildComposioToolSummary(name, args);
      const guard = await actionGuardAwait(actionId, summary);
      if (guard.decision === "denied" || guard.decision === "timeout") {
        return formatToolResult(stubComposioToolResponse(name, args));
      }
    }

    try {
      const client = await getUpstreamClient();
      const result = await client.callTool({ name, arguments: args });
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
