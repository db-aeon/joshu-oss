/**
 * REST inspect routes for File Brain — same gbrain MCP session as Hermes HTTP MCP.
 */

import { isReadOnlyGbrainTool } from "./gbrain-mcp-readonly.mjs";
import { parseTotalPagesFromSourcesPayload } from "./gbrain-index-health.mjs";

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

/**
 * @param {ReturnType<typeof import('./gbrain-mcp-bridge.mjs').createGbrainMcpBridge>} bridge
 * @param {(msg: string) => void} log
 * @param {{ getPdfIngestStatus?: () => Record<string, unknown>, getTxtIngestStatus?: () => Record<string, unknown> }} [activity]
 */
export function createGbrainMcpRestHandler(bridge, log, activity = {}) {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return async function handleRest(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        let sessionError = "";
        if (!bridge.isReady()) {
          try {
            await bridge.ensureReady();
          } catch (err) {
            sessionError = err instanceof Error ? err.message : String(err);
          }
        }
        const pdfIngest = activity.getPdfIngestStatus?.() ?? null;
        const txtIngest = activity.getTxtIngestStatus?.() ?? null;
        const reindex = typeof bridge.getActivityStatus === "function" ? bridge.getActivityStatus() : null;
        const busy =
          Boolean(pdfIngest?.active) || Boolean(txtIngest?.active) || Boolean(reindex?.active);
        /** @type {Record<string, unknown>} */
        const body = {
          ok: true,
          lane: "gbrain-mcp-http",
          session_ready: bridge.isReady(),
          ...(sessionError ? { session_error: sessionError } : {}),
          activity: {
            busy,
            pdf_ingest: pdfIngest,
            txt_ingest: txtIngest,
            reindex,
          },
        };
        if (bridge.isReady()) {
          try {
            const text = await bridge.callToolText("sources_list", {});
            body.page_count = parseTotalPagesFromSourcesPayload(text);
          } catch {
            /* best-effort */
          }
        }
        json(res, 200, body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/activity") {
        const pdfIngest = activity.getPdfIngestStatus?.() ?? null;
        const txtIngest = activity.getTxtIngestStatus?.() ?? null;
        const reindex = typeof bridge.getActivityStatus === "function" ? bridge.getActivityStatus() : null;
        json(res, 200, {
          ok: true,
          busy:
            Boolean(pdfIngest?.active) || Boolean(txtIngest?.active) || Boolean(reindex?.active),
          pdf_ingest: pdfIngest,
          txt_ingest: txtIngest,
          reindex,
          lane: "gbrain-mcp-http",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/sources") {
        const text = await bridge.callToolText("sources_list", {});
        json(res, 200, {
          ok: true,
          raw: text,
          total_pages: parseTotalPagesFromSourcesPayload(text),
          lane: "gbrain-mcp-http",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/doctor") {
        const text = await bridge.callToolText("get_brain_identity", {});
        json(res, 200, { ok: true, raw: text, lane: "gbrain-mcp-http" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/list") {
        const limit = Math.min(
          100,
          Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50,
        );
        const typeFilter = url.searchParams.get("type")?.trim() || "";
        // list_pages only returns the default source; get_recent_salience spans all sources.
        const text = await bridge.callToolText("get_recent_salience", {
          limit,
          days: Number.parseInt(url.searchParams.get("days") || "3650", 10) || 3650,
        });
        let rows = [];
        try {
          const parsed = JSON.parse(text || "[]");
          if (Array.isArray(parsed)) {
            rows = parsed;
          } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.pages)) {
            rows = parsed.pages;
          } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.results)) {
            rows = parsed.results;
          } else {
            rows = [];
          }
        } catch {
          rows = [];
        }
        if (typeFilter && Array.isArray(rows)) {
          rows = rows.filter((row) => row && typeof row === "object" && row.type === typeFilter);
        }
        const sort = url.searchParams.get("sort") || "updated_desc";
        if (Array.isArray(rows) && sort.startsWith("updated")) {
          rows.sort((a, b) => {
            const av = Date.parse(String(a?.updated_at || "")) || 0;
            const bv = Date.parse(String(b?.updated_at || "")) || 0;
            return sort === "updated_asc" ? av - bv : bv - av;
          });
        }
        if (!Array.isArray(rows)) {
          rows = [];
        }
        json(res, 200, { ok: true, raw: JSON.stringify(rows.slice(0, limit)), lane: "gbrain-mcp-http" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/get") {
        const slug = url.searchParams.get("slug")?.trim();
        if (!slug) {
          json(res, 400, { ok: false, error: "Missing slug" });
          return;
        }
        const text = await bridge.callToolText("get_page", { slug });
        json(res, 200, { ok: true, raw: text, slug, lane: "gbrain-mcp-http" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/search") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) {
          json(res, 400, { ok: false, error: "Missing q" });
          return;
        }
        const sourceId = url.searchParams.get("source_id")?.trim() || "__all__";
        // MCP `search` has no source_id input; use hybrid `query` for cross-source retrieval.
        const text = await bridge.callToolText("query", {
          query: q,
          limit: Number(url.searchParams.get("limit") || 10),
          source_id: sourceId,
          detail: "low",
          expand: false,
        });
        json(res, 200, { ok: true, raw: text, query: q, source_id: sourceId, lane: "gbrain-mcp-http" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/query") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) {
          json(res, 400, { ok: false, error: "Missing q" });
          return;
        }
        const sourceId = url.searchParams.get("source_id")?.trim() || "__all__";
        const text = await bridge.callToolText("query", {
          query: q,
          source_id: sourceId,
          limit: Number(url.searchParams.get("limit") || 20),
          detail: "low",
          expand: false,
        });
        json(res, 200, { ok: true, raw: text, query: q, source_id: sourceId, lane: "gbrain-mcp-http" });
        return;
      }

      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`REST error ${url.pathname}: ${message}`);
      json(res, 502, { ok: false, error: message, lane: "gbrain-mcp-http" });
      return true;
    }
  };
}

export { isReadOnlyGbrainTool };
