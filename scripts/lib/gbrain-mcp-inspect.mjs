/**
 * Loopback HTTP inspect lane for gbrain MCP (same PGLite holder as Hermes).
 * Used by File Brain viewer via brainApi — not a filesystem substitute.
 */

import http from "node:http";
import { isReadOnlyGbrainTool } from "./gbrain-mcp-readonly.mjs";

/** @typedef {{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; kind: string }} InspectPending */

/**
 * @param {import('node:stream').Writable} childWriter
 * @param {(stream: import('node:stream').Writable, obj: Record<string, unknown>) => void} writeMessage
 * @param {(msg: string) => void} log
 */
export function createGbrainMcpInspect(childWriter, writeMessage, log) {
  /** @type {Map<number, InspectPending>} */
  const pending = new Map();
  let nextId = 800_000;
  /** Hermes already initialized gbrain serve on this stdio session — do not re-initialize. */
  let parentSessionReady = false;

  /**
   * Call when Hermes initialize completes on the shared gbrain serve session.
   */
  function markParentSessionReady() {
    parentSessionReady = true;
  }

  /**
   * @param {Record<string, unknown>} msg
   * @returns {boolean}
   */
  function handleChildMessage(msg) {
    const id = msg.id;
    if (id === undefined || id === null || !pending.has(id)) return false;

    const entry = pending.get(id);
    pending.delete(id);
    clearTimeout(entry.timer);

    if (msg.error) {
      const errObj = msg.error;
      const message =
        typeof errObj === "object" && errObj && "message" in errObj
          ? String(/** @type {{ message?: string }} */ (errObj).message)
          : JSON.stringify(errObj);
      entry.reject(new Error(message));
      return true;
    }

    entry.resolve(msg.result);
    return true;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<unknown>}
   */
  function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out`));
        }
      }, 30_000);

      pending.set(id, { resolve, reject, timer, kind: method });
      writeMessage(childWriter, { jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Initialize gbrain serve MCP session when Hermes has not connected yet.
   */
  async function ensureMcpSession() {
    if (parentSessionReady) return;

    const id = nextId++;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("MCP initialize timed out (gbrain serve may be starting or PGLite locked)"));
        }
      }, 20_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
        kind: "initialize",
      });
      writeMessage(childWriter, {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "gbrain-mcp-inspect", version: "1.0.0" },
        },
      });
    });

    if (!result || typeof result !== "object") {
      throw new Error("MCP initialize returned empty result");
    }
    writeMessage(childWriter, { jsonrpc: "2.0", method: "notifications/initialized" });
    parentSessionReady = true;
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   * @returns {Promise<string>}
   */
  async function callTool(name, args = {}) {
    if (!isReadOnlyGbrainTool(name)) {
      throw new Error(`Tool not allowed on inspect lane: ${name}`);
    }
    await ensureMcpSession();
    const result = await sendRequest("tools/call", { name, arguments: args });
    parentSessionReady = true;
    return extractMcpToolText(result);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} body
   */
  async function handleHttp(req, res, body) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        let sessionError = "";
        if (!parentSessionReady) {
          try {
            await ensureMcpSession();
          } catch (err) {
            sessionError = err instanceof Error ? err.message : String(err);
          }
        }
        json(res, 200, {
          ok: true,
          lane: "gbrain-mcp",
          hermes_session_ready: parentSessionReady,
          ...(sessionError ? { session_error: sessionError } : {}),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/doctor") {
        const text = await callTool("get_brain_identity", {});
        json(res, 200, { ok: true, raw: text });
        return;
      }

      if (req.method === "GET" && url.pathname === "/list") {
        const text = await callTool("list_pages", {
          limit: Number(url.searchParams.get("limit") || 50),
          sort: url.searchParams.get("sort") || "updated_desc",
          ...(url.searchParams.get("type") ? { type: url.searchParams.get("type") } : {}),
        });
        json(res, 200, { ok: true, raw: text, lane: "gbrain-mcp" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/get") {
        const slug = url.searchParams.get("slug")?.trim();
        if (!slug) {
          json(res, 400, { ok: false, error: "Missing slug" });
          return;
        }
        const text = await callTool("get_page", { slug });
        json(res, 200, { ok: true, raw: text, slug, lane: "gbrain-mcp" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/search") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) {
          json(res, 400, { ok: false, error: "Missing q" });
          return;
        }
        const text = await callTool("search", {
          query: q,
          limit: Number(url.searchParams.get("limit") || 10),
        });
        json(res, 200, { ok: true, raw: text, query: q, lane: "gbrain-mcp" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/query") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) {
          json(res, 400, { ok: false, error: "Missing q" });
          return;
        }
        const text = await callTool("query", { query: q });
        json(res, 200, { ok: true, raw: text, query: q, lane: "gbrain-mcp" });
        return;
      }

      json(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`inspect http error ${url.pathname}: ${message}`);
      json(res, 502, { ok: false, error: message, lane: "gbrain-mcp" });
    }
  }

  /**
   * @param {number} [port]
   */
  function startHttpServer(port = Number.parseInt(process.env.GBRAIN_MCP_INSPECT_PORT || "8793", 10)) {
    const server = http.createServer((req, res) => {
      void handleHttp(req, res, "");
    });
    server.on("error", (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === "EADDRINUSE") {
        log(
          `inspect HTTP port ${port} already in use; skipping bind (another gbrain MCP proxy holds the inspect lane)`,
        );
        return;
      }
      log(`inspect HTTP error: ${err instanceof Error ? err.message : err}`);
    });
    server.listen(port, "127.0.0.1", () => {
      log(`inspect HTTP on http://127.0.0.1:${port} (gbrain MCP lane)`);
    });
    return server;
  }

  return { handleChildMessage, startHttpServer, callTool, markParentSessionReady };
}

/**
 * @param {unknown} result
 * @returns {string}
 */
export function extractMcpToolText(result) {
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = /** @type {{ content?: unknown }} */ (result).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const row = /** @type {{ type?: string; text?: string }} */ (item);
      return row.type === "text" && typeof row.text === "string" ? row.text : JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(body)}\n`);
}
