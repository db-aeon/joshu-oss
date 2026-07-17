#!/usr/bin/env node
/**
 * Joshu-supervised gbrain MCP over HTTP (Streamable HTTP) + REST inspect for File Brain.
 *
 * One `gbrain serve` child holds PGLite; Hermes and File Brain connect as separate HTTP MCP sessions.
 *
 * Env: GBRAIN_BIN, GBRAIN_HOME, JOSHU_FILES_ROOT, GBRAIN_MCP_HTTP_PORT (default 8794)
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { isReadOnlyGbrainTool } from "./lib/gbrain-mcp-readonly.mjs";
import { createGbrainMcpBridge } from "./lib/gbrain-mcp-bridge.mjs";
import { createGbrainMcpRestHandler } from "./lib/gbrain-mcp-rest.mjs";
import { startKbPdfIngest, getKbPdfIngestStatus } from "./lib/kb-pdf-ingest.mjs";
import { startKbTxtIngest, getKbTxtIngestStatus } from "./lib/kb-txt-ingest.mjs";

const PORT = Number.parseInt(process.env.GBRAIN_MCP_HTTP_PORT || "8794", 10);
const HOST = process.env.GBRAIN_MCP_HTTP_HOST?.trim() || "127.0.0.1";

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

const bridge = createGbrainMcpBridge((msg) => log(msg));

/** @type {Map<string, { transport: StreamableHTTPServerTransport; server: Server }>} */
const sessions = new Map();

/**
 * @returns {Promise<Server>}
 */
async function createProxyServer() {
  const server = new Server(
    { name: "joshu-gbrain-mcp-http", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(InitializeRequestSchema, async () => {
    await bridge.ensureReady();
    const init = bridge.getInitResult();
    if (!init) throw new Error("gbrain MCP not initialized");
    return init;
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await bridge.listTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!isReadOnlyGbrainTool(name)) {
      return {
        content: [
          {
            type: "text",
            text:
              `Tool '${name}' is not available. Write files with Hermes filesystem tools under JOSHU_FILES_ROOT; gbrain MCP is read-only in Joshu.`,
          },
        ],
        isError: true,
      };
    }
    const result = await bridge.callTool(name, request.params.arguments ?? {});
    if (result && typeof result === "object") {
      return /** @type {import('@modelcontextprotocol/sdk/types.js').CallToolResult} */ (result);
    }
    return { content: [{ type: "text", text: String(result ?? "") }] };
  });

  return server;
}

async function main() {
  bridge.spawnGbrainServe();
  bridge.startFilesystemWatch();
  bridge.startPeriodicReindex();
  bridge.startEmptyIndexWatchdog();
  startKbPdfIngest({
    desktopRoot: process.env.JOSHU_DESKTOP_ROOT?.trim() || process.env.JOSHU_FILES_ROOT?.trim(),
    scheduleReindex: (ms) => bridge.scheduleReindex(ms),
    log: (msg) => log(msg),
  });
  startKbTxtIngest({
    desktopRoot: process.env.JOSHU_DESKTOP_ROOT?.trim() || process.env.JOSHU_FILES_ROOT?.trim(),
    scheduleReindex: (ms) => bridge.scheduleReindex(ms),
    log: (msg) => log(msg),
  });
  // Catch-up reindex shortly after boot (in addition to periodic + fs watch).
  bridge.scheduleReindex(8_000);

  const handleRest = createGbrainMcpRestHandler(bridge, (msg) => log(msg), {
    getPdfIngestStatus: getKbPdfIngestStatus,
    getTxtIngestStatus: getKbTxtIngestStatus,
  });
  const app = createMcpExpressApp({ host: HOST });

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
              log(`MCP session ${sid} closed`);
            },
          });
          const server = await createProxyServer();
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
      log(`MCP HTTP error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  app.use(async (req, res, next) => {
    const handled = await handleRest(req, res);
    if (handled !== false) return;
    next();
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: "Not found" });
  });

  // Warm session in background; /health reports session_ready.
  app.listen(PORT, HOST, () => {
    log(`gbrain MCP HTTP on http://${HOST}:${PORT} (mcp + REST inspect)`);
    void bridge.ensureReady().catch((err) => {
      log(`WARN: MCP session warm-up: ${err instanceof Error ? err.message : err}`);
    });
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
