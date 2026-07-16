import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Tab = "browse" | "search" | "query";

type BrainStatus = {
  ok: boolean;
  lane?: string;
  mcp_inspect?: boolean;
  hint?: string;
  health_score?: number | null;
  status?: string | null;
  paths?: {
    filesRoot?: string;
    desktopRoot?: string;
    gbrainHome?: string;
    arozUser?: string;
  };
  schema?: {
    total_pages?: number | null;
    raw?: string;
  };
  activity?: {
    busy?: boolean;
    pdf_ingest?: {
      active?: boolean;
      phase?: string;
      reason?: string;
      last_message?: string;
      last_ingested?: number;
      last_updated?: number;
      last_errors?: number;
    } | null;
    reindex?: {
      active?: boolean;
      reindex_running?: boolean;
      reindex_scheduled?: boolean;
      reindex_pending?: boolean;
    } | null;
  };
  error?: string;
};

type BrainPage = {
  slug: string;
  type: string;
  date: string;
  title: string;
};

type BrainSearchHit = {
  score?: number;
  slug: string;
  snippet: string;
};

type BrainSearchResponse = {
  query: string;
  hit_count: number;
  hits: BrainSearchHit[];
  summary?: string;
};

type BrainQueryResponse = {
  query: string;
  answer: string;
  hit_count: number;
};

type PageDetail = {
  slug: string;
  content: string;
};

const API_BASE = (import.meta.env.VITE_FILE_BRAIN_API_BASE || "/joshu/api/brain").replace(/\/+$/, "");

let cachedReadApiKey: string | null | undefined;

async function resolveReadApiKey(): Promise<string | null> {
  if (cachedReadApiKey !== undefined) return cachedReadApiKey;
  const response = await fetch(`${API_BASE}/viewer-config`, { cache: "no-store" });
  if (!response.ok) {
    cachedReadApiKey = null;
    return null;
  }
  const body = (await response.json()) as { readApiKey?: string | null };
  cachedReadApiKey = typeof body.readApiKey === "string" && body.readApiKey.trim() ? body.readApiKey.trim() : null;
  return cachedReadApiKey;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const readApiKey = await resolveReadApiKey();
  const headers = new Headers(init?.headers);
  if (readApiKey) headers.set("Authorization", `Bearer ${readApiKey}`);
  const response = await fetch(url, { cache: "no-store", ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return JSON.parse(text) as T;
}

function DetailPanel({
  slug,
  detail,
  loading,
  error,
}: {
  slug?: string;
  detail?: PageDetail;
  loading: boolean;
  error: string;
}) {
  if (!slug) {
    return (
      <aside className="details-panel">
        <h2>Inspect</h2>
        <p>Select a page to view its indexed content.</p>
      </aside>
    );
  }

  return (
    <aside className="details-panel">
      <p className="eyebrow">Page</p>
      <h2>{slug}</h2>
      {loading && <p>Loading page…</p>}
      {error && <pre className="error-box">{error}</pre>}
      {!loading && !error && detail && <pre className="page-content">{detail.content}</pre>}
    </aside>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("browse");
  const [status, setStatus] = useState<BrainStatus>();
  const [pages, setPages] = useState<BrainPage[]>([]);
  const [searchHits, setSearchHits] = useState<BrainSearchHit[]>([]);
  const [queryAnswer, setQueryAnswer] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string>();
  const [pageDetail, setPageDetail] = useState<PageDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [reindexMessage, setReindexMessage] = useState("");
  const [laneLabel, setLaneLabel] = useState("");

  const [limit, setLimit] = useState(50);
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState("updated_desc");
  const [searchText, setSearchText] = useState("");
  const [queryText, setQueryText] = useState("");
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [lastQueryText, setLastQueryText] = useState("");

  const loadStatus = useCallback(() => {
    fetchJson<BrainStatus>(`${API_BASE}/status`)
      .then((next) => {
        setStatus(next);
        if (next.lane === "gbrain-mcp") {
          setLaneLabel("Lane: gbrain MCP (Hermes gbrain serve)");
        } else if (next.lane === "gbrain-cli") {
          setLaneLabel("Lane: gbrain CLI (direct PGLite)");
        } else {
          setLaneLabel("");
        }
      })
      .catch((err: Error) => setStatus({ ok: false, error: err.message }));
  }, []);

  const loadPage = useCallback((slug: string) => {
    setSelectedSlug(slug);
    setDetailLoading(true);
    setDetailError("");
    setPageDetail(undefined);
    fetchJson<PageDetail>(`${API_BASE}/pages/${encodeURIComponent(slug)}`)
      .then(setPageDetail)
      .catch((err: Error) => setDetailError(err.message))
      .finally(() => setDetailLoading(false));
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus, refreshKey]);

  // Poll while PDF ingest or reindex is active so the status pill stays live.
  useEffect(() => {
    const busy = Boolean(status?.activity?.busy);
    const intervalMs = busy ? 1500 : 8000;
    const id = window.setInterval(() => {
      loadStatus();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [loadStatus, status?.activity?.busy]);

  useEffect(() => {
    if (tab !== "browse") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      limit: String(limit),
      sort,
    });
    if (typeFilter.trim()) params.set("type", typeFilter.trim());

    fetchJson<{ pages: BrainPage[]; lane?: string }>(`${API_BASE}/pages?${params.toString()}`)
      .then((body) => {
        if (!cancelled) {
          setPages(body.pages ?? []);
          if (body.lane) setLaneLabel(`Lane: ${body.lane}`);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, limit, typeFilter, sort, refreshKey]);

  const runSearch = () => {
    const q = searchText.trim();
    if (!q) return;
    setLoading(true);
    setError("");
    setLastSearchQuery(q);
    fetchJson<BrainSearchResponse & { lane?: string }>(`${API_BASE}/search?q=${encodeURIComponent(q)}&limit=20`)
      .then((body) => {
        setSearchHits(body.hits ?? []);
        if (body.lane) setLaneLabel(`Lane: ${body.lane}`);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const runQuery = () => {
    const q = queryText.trim();
    if (!q) return;
    setLoading(true);
    setError("");
    setLastQueryText(q);
    fetchJson<BrainQueryResponse & { lane?: string }>(`${API_BASE}/query?q=${encodeURIComponent(q)}`)
      .then((body) => {
        setQueryAnswer(body.answer);
        if (body.lane) setLaneLabel(`Lane: ${body.lane}`);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const runReindex = () => {
    setReindexMessage("");
    fetchJson<{ ok: boolean; message?: string }>(`${API_BASE}/reindex`, { method: "POST" })
      .then((body) => setReindexMessage(body.message ?? "Reindex scheduled"))
      .catch((err: Error) => setReindexMessage(err.message));
  };

  const statusLabel = status?.ok
    ? status.lane === "gbrain-mcp-http" || status.lane === "gbrain-mcp"
      ? `gbrain MCP · ${status.schema?.total_pages ?? "?"} pages indexed`
      : `Health ${status.health_score ?? "?"} · ${status.schema?.total_pages ?? "?"} pages`
    : status?.error ?? "Checking gbrain…";

  const pdfPhase = status?.activity?.pdf_ingest?.phase;
  const pdfActive = Boolean(status?.activity?.pdf_ingest?.active);
  const reindexActive = Boolean(status?.activity?.reindex?.active);
  const activityBusy = Boolean(status?.activity?.busy) || pdfActive || reindexActive;

  let activityLabel = "";
  if (pdfActive && (pdfPhase === "running" || pdfPhase === "scheduled")) {
    activityLabel =
      pdfPhase === "running"
        ? status?.activity?.pdf_ingest?.last_message || "Extracting PDFs…"
        : "PDF ingest scheduled…";
  } else if (reindexActive) {
    activityLabel = status?.activity?.reindex?.reindex_running
      ? "Reindexing File Brain…"
      : "Reindex scheduled…";
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Joshu File Brain</p>
          <h1>File Brain</h1>
        </div>
        <div className="status-cluster">
          {activityBusy && activityLabel && (
            <div className="status-pill status-busy" title={status?.activity?.pdf_ingest?.reason || ""}>
              <span />
              {activityLabel}
            </div>
          )}
          <div className={`status-pill ${status?.ok ? "status-ready" : "status-error"}`}>
            <span />
            {statusLabel}
          </div>
        </div>
      </header>

      {status?.paths && (
        <section className="status-card">
          <h2>Index paths</h2>
          <div className="status-grid">
            {status.paths.filesRoot && (
              <div>
                <strong>Files root</strong>
                <span>{status.paths.filesRoot}</span>
              </div>
            )}
            {status.paths.desktopRoot && (
              <div>
                <strong>Desktop root</strong>
                <span>{status.paths.desktopRoot}</span>
              </div>
            )}
            {status.paths.gbrainHome && (
              <div>
                <strong>GBRAIN_HOME</strong>
                <span>{status.paths.gbrainHome}</span>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="controls">
        <div className="tabs">
          <button type="button" className={tab === "browse" ? "active" : ""} onClick={() => setTab("browse")}>
            Browse
          </button>
          <button type="button" className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
            Search
          </button>
          <button type="button" className={tab === "query" ? "active" : ""} onClick={() => setTab("query")}>
            Query
          </button>
        </div>

        {tab === "browse" && (
          <>
            <label>
              Limit
              <input type="number" min={10} max={500} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            </label>
            <label>
              Type
              <input value={typeFilter} placeholder="journal, research…" onChange={(e) => setTypeFilter(e.target.value)} />
            </label>
            <label>
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="updated_desc">Updated (newest)</option>
                <option value="updated_asc">Updated (oldest)</option>
                <option value="created_desc">Created (newest)</option>
                <option value="slug">Slug</option>
              </select>
            </label>
          </>
        )}

        {tab === "search" && (
          <>
            <label className="search-field">
              Keywords
              <input
                value={searchText}
                placeholder="Search indexed files…"
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
              />
            </label>
            <button type="button" className="action-button" onClick={runSearch}>
              Search
            </button>
          </>
        )}

        {tab === "query" && (
          <>
            <label className="search-field">
              Question
              <input
                value={queryText}
                placeholder="Ask a natural-language question…"
                onChange={(e) => setQueryText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runQuery()}
              />
            </label>
            <button type="button" className="action-button" onClick={runQuery}>
              Ask
            </button>
          </>
        )}

        <button type="button" className="refresh-button" onClick={() => setRefreshKey((v) => v + 1)}>
          Refresh
        </button>
        <button type="button" className="action-button" onClick={runReindex}>
          Reindex
        </button>
      </section>

      {status?.hint && <p className="table-meta">{status.hint}</p>}
      {laneLabel && <p className="table-meta">{laneLabel}</p>}
      {reindexMessage && <p className="table-meta">{reindexMessage}</p>}
      {error && <pre className="error-box">{error}</pre>}

      {tab === "query" ? (
        <div className="query-panel">
          {loading ? (
            <section className="graph-empty">Running query…</section>
          ) : (
            <section className="query-result">
              {lastQueryText ? (
                <>
                  <p className="eyebrow">Answer</p>
                  <p>{queryAnswer || "No answer returned."}</p>
                </>
              ) : (
                <p>Enter a question and click Ask to query the file brain.</p>
              )}
            </section>
          )}
          <DetailPanel slug={selectedSlug} detail={pageDetail} loading={detailLoading} error={detailError} />
        </div>
      ) : (
        <div className="viewer-grid">
          {loading ? (
            <section className="graph-empty">Loading…</section>
          ) : tab === "browse" ? (
            <section className="table-card">
              <div className="table-meta">
                <span>{pages.length} page(s)</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Slug</th>
                      <th>Type</th>
                      <th>Date</th>
                      <th>Title</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((page) => (
                      <tr
                        key={page.slug}
                        className={selectedSlug === page.slug ? "selected" : ""}
                        onClick={() => loadPage(page.slug)}
                      >
                        <td className="primary-cell">{page.slug}</td>
                        <td>{page.type || "-"}</td>
                        <td>{page.date || "-"}</td>
                        <td>{page.title || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {pages.length === 0 && <p className="graph-empty">No indexed pages found.</p>}
              </div>
            </section>
          ) : (
            <section className="table-card">
              <div className="table-meta">
                <span>
                  {searchHits.length} hit(s)
                  {lastSearchQuery ? ` for "${lastSearchQuery}"` : ""}
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Score</th>
                      <th>Slug</th>
                      <th>Snippet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchHits.map((hit) => (
                      <tr
                        key={`${hit.slug}:${hit.score ?? "na"}`}
                        className={selectedSlug === hit.slug ? "selected" : ""}
                        onClick={() => loadPage(hit.slug)}
                      >
                        <td>
                          {typeof hit.score === "number" ? hit.score.toFixed(2) : "-"}
                        </td>
                        <td className="primary-cell">{hit.slug}</td>
                        <td>{(hit.snippet || "").split("\n")[0] || "(no snippet)"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {searchHits.length === 0 && lastSearchQuery && (
                  <p className="graph-empty">No search results.</p>
                )}
                {!lastSearchQuery && <p className="graph-empty">Run a search to see results.</p>}
              </div>
            </section>
          )}
          <DetailPanel slug={selectedSlug} detail={pageDetail} loading={detailLoading} error={detailError} />
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
