#!/usr/bin/env node
/**
 * Shared metered-provider MCP relay — forwards tool calls to control plane.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const PROVIDER_ID = process.env.JOSHU_METERED_MCP_PROVIDER_ID?.trim() || "fal";
const RELAY_URL = process.env.JOSHU_METERED_MCP_RELAY_URL?.trim() || "";
const PORT = Number.parseInt(process.env.JOSHU_METERED_MCP_PORT || "8797", 10);
const HOST = process.env.JOSHU_METERED_MCP_HOST?.trim() || "127.0.0.1";

/** @type {Map<string, { transport: StreamableHTTPServerTransport; server: Server }>} */
const sessions = new Map();

function log(msg) {
  process.stderr.write(`[metered-mcp:${PROVIDER_ID}] ${msg}\n`);
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function agentBearerToken() {
  const instanceId =
    readString(process.env.JOSHU_INSTANCE_ID) ||
    readString(process.env.INSTANCE_ID);
  const raw = readString(process.env.INSTANCE_AGENT_TOKEN);
  if (!instanceId || !raw) {
    throw new Error("JOSHU_INSTANCE_ID and INSTANCE_AGENT_TOKEN required");
  }
  return raw.startsWith(`${instanceId}.`) ? raw : `${instanceId}.${raw}`;
}

async function cpForwardJsonRpc(jsonRpc, sessionHeaders = {}) {
  if (!RELAY_URL) throw new Error("JOSHU_METERED_MCP_RELAY_URL not set");
  const res = await fetch(RELAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentBearerToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...sessionHeaders,
    },
    body: JSON.stringify({ jsonRpc, sessionHeaders }),
  });
  const json = await res.json();
  if (!res.ok || json.error === "insufficient_balance") {
    const message = json.error || json.message || `CP relay HTTP ${res.status}`;
    throw new Error(message);
  }
  return json.json ?? json;
}

function extractTools(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.tools)) return payload.tools;
  if (payload.result && Array.isArray(payload.result.tools)) return payload.result.tools;
  return [];
}

function formatToolResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

async function createMcpServer() {
  const server = new Server(
    { name: `metered-mcp-${PROVIDER_ID}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const payload = await cpForwardJsonRpc({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/list",
      params: {},
    });
    return { tools: extractTools(payload) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      const payload = await cpForwardJsonRpc({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      });
      // The control plane can refuse a call with a JSON-RPC error, for example tool_not_allowed.
      if (payload?.error) {
        const reason = readString(payload.error.message) || "error";
        return { content: [{ type: "text", text: `Metered provider error: ${reason}` }], isError: true };
      }
      if (payload?.content) return payload;
      if (payload?.result?.content) return payload.result;
      return formatToolResult(payload?.result ?? payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Metered provider error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  if (!RELAY_URL) {
    log("JOSHU_METERED_MCP_RELAY_URL not set — exiting");
    process.exit(1);
  }

  const app = createMcpExpressApp({ host: HOST });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: `metered-mcp-${PROVIDER_ID}`, provider: PROVIDER_ID });
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
    log(`listening on http://${HOST}:${PORT}/mcp relay=${RELAY_URL}`);
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
