/**
 * HTTP client for Joshu-supervised gbrain MCP REST inspect (port 8794).
 */

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function mcpHttpBaseUrl(): string {
  return envTrim("GBRAIN_MCP_HTTP_URL", "http://127.0.0.1:8794").replace(/\/+$/, "");
}

/** @deprecated Use GBRAIN_MCP_HTTP_URL */
function legacyInspectBaseUrl(): string {
  return envTrim("GBRAIN_MCP_INSPECT_URL", mcpHttpBaseUrl()).replace(/\/+$/, "");
}

type InspectResponse = {
  ok: boolean;
  raw?: string;
  error?: string;
  lane?: string;
};

async function fetchInspect(path: string, timeoutMs = 30_000): Promise<InspectResponse> {
  const url = `${legacyInspectBaseUrl()}${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  const body = (await response.json()) as InspectResponse;
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

export function isInspectUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND";
}

/** Sum page counts from `sources_list` JSON or `gbrain sources list` text. */
export function parseTotalPagesFromSourcesList(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { sources?: Array<{ page_count?: number }> };
    if (Array.isArray(parsed.sources)) {
      let total = 0;
      let found = false;
      for (const src of parsed.sources) {
        if (typeof src?.page_count === "number") {
          total += src.page_count;
          found = true;
        }
      }
      if (found) return total;
    }
  } catch {
    /* fall through to CLI-style lines */
  }
  let total = 0;
  let found = false;
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /(\d+)\s+pages\b/i.exec(line);
    if (!match) continue;
    total += Number.parseInt(match[1]!, 10) || 0;
    found = true;
  }
  return found ? total : null;
}

/** Total indexed pages via MCP REST (same PGLite holder as Hermes — no CLI lock). */
export async function fetchGbrainMcpTotalPages(timeoutMs = 12_000): Promise<number | null> {
  try {
    const response = await fetch(`${legacyInspectBaseUrl()}/sources`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const body = (await response.json()) as {
      ok?: boolean;
      total_pages?: number | null;
      raw?: string;
      error?: string;
    };
    if (!response.ok || !body.ok) {
      throw new Error(body.error || `${response.status} ${response.statusText}`);
    }
    if (typeof body.total_pages === "number") return body.total_pages;
    if (body.raw) return parseTotalPagesFromSourcesList(body.raw);
    return null;
  } catch {
    return null;
  }
}

export type GbrainMcpHealthStatus = {
  reachable: boolean;
  ok: boolean;
  sessionReady: boolean;
};

/** Layered MCP health: process up vs MCP session initialized (Hermes / File Brain need session_ready). */
export async function fetchGbrainMcpHealthStatus(
  timeoutMs = 2000,
): Promise<GbrainMcpHealthStatus> {
  try {
    const response = await fetch(`${legacyInspectBaseUrl()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) {
      return { reachable: true, ok: false, sessionReady: false };
    }
    const body = (await response.json()) as { ok?: boolean; session_ready?: boolean };
    return {
      reachable: true,
      ok: body.ok === true,
      sessionReady: body.session_ready === true,
    };
  } catch (err) {
    if (isInspectUnavailableError(err)) {
      return { reachable: false, ok: false, sessionReady: false };
    }
    return { reachable: false, ok: false, sessionReady: false };
  }
}

export async function probeGbrainMcpInspect(): Promise<boolean> {
  const status = await fetchGbrainMcpHealthStatus(800);
  return status.ok && status.sessionReady;
}

export async function gbrainMcpList(params: {
  limit: number;
  type?: string;
  sort: string;
}): Promise<string> {
  const q = new URLSearchParams({
    limit: String(params.limit),
    sort: params.sort,
  });
  if (params.type) q.set("type", params.type);
  const body = await fetchInspect(`/list?${q.toString()}`);
  return body.raw ?? "";
}

export async function gbrainMcpGetPage(slug: string): Promise<string> {
  const body = await fetchInspect(`/get?slug=${encodeURIComponent(slug)}`);
  return body.raw ?? "";
}

export async function gbrainMcpSearch(query: string, limit: number): Promise<string> {
  const q = new URLSearchParams({ q: query, limit: String(limit) });
  const body = await fetchInspect(`/search?${q.toString()}`);
  return body.raw ?? "";
}

export async function gbrainMcpQuery(question: string, limit = 20): Promise<string> {
  const q = new URLSearchParams({ q: question, limit: String(limit) });
  const body = await fetchInspect(`/query?${q.toString()}`);
  return body.raw ?? "";
}

export function formatGbrainCliError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/pglite lock|timed out waiting for/i.test(msg)) {
    return "gbrain PGLite is locked. Start the Joshu gbrain MCP HTTP server (npm run dev:arozos / scripts/start-gbrain-mcp-http.sh) or stop conflicting gbrain processes.";
  }
  if (/Command failed:.*gbrain/i.test(msg) && /ETIMEDOUT|SIGTERM|killed/i.test(msg)) {
    return "gbrain CLI timed out (likely PGLite lock). Ensure gbrain MCP HTTP is running on :8794, or stop conflicting gbrain processes.";
  }
  return msg.replace(/^Command failed: [^\n]+\n?/, "").trim() || msg;
}
