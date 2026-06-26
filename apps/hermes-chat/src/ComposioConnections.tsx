import React, { useCallback, useEffect, useMemo, useState } from "react";

export type ComposioToolkitRow = {
  slug: string;
  name: string;
  logo?: string;
  isConnected: boolean;
  connectedAccountId?: string;
};

type Props = {
  apiBase: string;
  open: boolean;
  onClose: () => void;
};

const COMPOSIO_API = (base: string) => `${base.replace(/\/+$/, "")}/composio`;

export function ComposioConnections({ apiBase, open, onClose }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [toolkits, setToolkits] = useState<ComposioToolkitRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const composioRoot = useMemo(() => COMPOSIO_API(apiBase), [apiBase]);

  const refresh = useCallback(async (opts?: { restartGateway?: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const statusRes = await fetch(`${composioRoot}/status`, { cache: "no-store" });
      const statusJson = (await statusRes.json()) as { enabled?: boolean };
      setEnabled(Boolean(statusJson.enabled));
      if (!statusJson.enabled) {
        setToolkits([]);
        return;
      }

      await fetch(`${composioRoot}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restartGateway: opts?.restartGateway === true }),
      }).catch(() => undefined);

      const params = new URLSearchParams();
      const q = search.trim();
      if (q) params.set("search", q);
      const listRes = await fetch(`${composioRoot}/toolkits?${params}`, { cache: "no-store" });
      if (!listRes.ok) throw new Error(await listRes.text());
      const listJson = (await listRes.json()) as { toolkits?: ComposioToolkitRow[] };
      setToolkits(Array.isArray(listJson.toolkits) ? listJson.toolkits : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [composioRoot, search]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => void refresh({ restartGateway: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, refresh]);

  const connect = async (slug: string) => {
    setBusySlug(slug);
    setError("");
    try {
      const res = await fetch(`${composioRoot}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: slug, callbackUrl: window.location.href }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as { redirectUrl?: string };
      if (!json.redirectUrl) throw new Error("Missing redirect URL from Composio");

      // jChat runs inside an ArozOS desktop iframe; navigating this frame to Composio
      // OAuth fails (X-Frame-Options / "Unsafe attempt to load URL … from frame").
      const popup = window.open(json.redirectUrl, "_blank", "noopener,noreferrer");
      if (!popup) {
        throw new Error(
          "Pop-up blocked. Allow pop-ups for this site, then try Connect again.",
        );
      }
      setBusySlug(null);

      const poll = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(poll);
        void refresh({ restartGateway: true });
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusySlug(null);
    }
  };

  const disconnect = async (row: ComposioToolkitRow) => {
    if (!row.connectedAccountId) return;
    setBusySlug(row.slug);
    setError("");
    try {
      const res = await fetch(`${composioRoot}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectedAccountId: row.connectedAccountId }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySlug(null);
    }
  };

  if (!open) return null;

  return (
    <div className="composio-overlay" role="presentation" onClick={onClose}>
      <div
        className="composio-dialog"
        role="dialog"
        aria-labelledby="composio-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="composio-dialog-header">
          <div>
            <p className="eyebrow">Integrations</p>
            <h2 id="composio-dialog-title">Connect apps</h2>
            <p className="composio-dialog-sub">
              Link Gmail, GitHub, Slack, and more. Hermes can use these tools in chat after you connect.
            </p>
          </div>
          <button type="button" className="composio-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {enabled === false && (
          <p className="composio-hint">
            Composio is not configured on this box. Set <code>COMPOSIO_API_KEY</code> in Joshu env and restart.
          </p>
        )}

        {enabled !== false && (
          <>
            <div className="composio-search-row">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search providers (e.g. gmail, notion)…"
                aria-label="Search providers"
              />
              <button type="button" onClick={() => void refresh()} disabled={loading}>
                {loading ? "Loading…" : "Search"}
              </button>
            </div>

            {error && <p className="composio-error">{error}</p>}

            <ul className="composio-list">
              {toolkits.map((row) => (
                <li key={row.slug} className="composio-row">
                  <div className="composio-row-main">
                    {row.logo ? (
                      <img src={row.logo} alt="" className="composio-logo" loading="lazy" />
                    ) : (
                      <span className="composio-logo composio-logo-fallback" aria-hidden>
                        {row.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div>
                      <strong>{row.name}</strong>
                      <small>{row.isConnected ? "Connected" : "Not connected"}</small>
                    </div>
                  </div>
                  {row.isConnected ? (
                    <button
                      type="button"
                      className="composio-btn composio-btn-muted"
                      disabled={busySlug === row.slug}
                      onClick={() => void disconnect(row)}
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="composio-btn composio-btn-primary"
                      disabled={busySlug === row.slug}
                      onClick={() => void connect(row.slug)}
                    >
                      {busySlug === row.slug ? "Opening…" : "Connect"}
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {!loading && toolkits.length === 0 && enabled && (
              <p className="composio-hint">No providers match your search. Try &quot;gmail&quot; or &quot;github&quot;.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
