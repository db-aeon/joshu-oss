import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type ViewKind = "constellation" | "cooccurrence";
type DisplayMode = "graph" | "table";

type GraphDataRecord = {
  id?: string;
  label?: string;
  text?: string;
  source?: string;
  target?: string;
  linkType?: string;
  weight?: number;
  color?: string;
  mentionCount?: number;
  date?: string;
  context?: string;
  entities?: string;
  entityName?: string;
  lastCooccurred?: string;
  [key: string]: unknown;
};

type GraphNode = { data: GraphDataRecord };
type GraphEdge = { data: GraphDataRecord };
type GraphResponse = {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  total_entities?: number;
  total_edges?: number;
  limit?: number;
};
type HindsightStatus = {
  ok: boolean;
  bankId?: string;
  apiUrl?: string;
  health?: unknown;
  error?: string;
};
type LayoutNode = GraphNode & {
  id: string;
  label: string;
  x: number;
  y: number;
  degree: number;
};
type SelectedItem = { type: "node"; value: LayoutNode } | { type: "edge"; value: GraphEdge };

const API_BASE = (import.meta.env.VITE_HINDSIGHT_VIEWER_API_BASE || "/joshu/api/hindsight").replace(/\/+$/, "");
const VIEWBOX_WIDTH = 1100;
const VIEWBOX_HEIGHT = 680;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function edgeKey(edge: GraphEdge, index: number): string {
  const data = edge.data;
  return asString(data.id, `${data.source ?? "source"}-${data.target ?? "target"}-${data.linkType ?? "edge"}-${index}`);
}

function normalizeNodes(nodes: GraphNode[] = [], edges: GraphEdge[] = []): LayoutNode[] {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const source = asString(edge.data.source);
    const target = asString(edge.data.target);
    if (!source || !target || source === target) continue;
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  }

  const sorted = nodes
    .map((node, index) => {
      const id = asString(node.data.id, `node-${index}`);
      return { node, id, label: asString(node.data.label, id) };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  const maxDegree = Math.max(1, ...sorted.map((item) => degree.get(item.id) ?? asNumber(item.node.data.mentionCount, 0)));
  return sorted.map((item, index) => {
    const nodeDegree = degree.get(item.id) ?? asNumber(item.node.data.mentionCount, 0);
    const angle = (index / Math.max(1, sorted.length)) * Math.PI * 2 + (hashString(item.id) % 17) * 0.015;
    const degreePull = nodeDegree / maxDegree;
    const ringOffset = (hashString(item.label) % 5) * 22;
    const radius = sorted.length <= 1 ? 0 : 110 + (1 - degreePull) * 210 + ringOffset;
    return {
      ...item.node,
      id: item.id,
      label: item.label,
      degree: nodeDegree,
      x: VIEWBOX_WIDTH / 2 + Math.cos(angle) * radius,
      y: VIEWBOX_HEIGHT / 2 + Math.sin(angle) * radius,
    };
  });
}

function graphSummary(graph: GraphResponse): string {
  const nodes = graph.nodes?.length ?? 0;
  const edges = graph.edges?.length ?? 0;
  const pairs = uniqueDirectedPairCount(graph.edges ?? []);
  return `${nodes} nodes, ${edges} raw edges, ${pairs} unique pairs`;
}

function uniqueDirectedPairCount(edges: GraphEdge[]): number {
  const pairs = new Set<string>();
  for (const edge of edges) {
    const source = asString(edge.data.source);
    const target = asString(edge.data.target);
    if (source && target) pairs.add(`${source}->${target}`);
  }
  return pairs.size;
}

function compactId(value: unknown): string {
  const text = asString(value);
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function tableCell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

function DetailPanel({ selected }: { selected?: SelectedItem }) {
  if (!selected) {
    return (
      <aside className="details-panel">
        <h2>Inspect</h2>
        <p>Select a node or edge to inspect the raw Hindsight metadata.</p>
      </aside>
    );
  }

  const data = selected.value.data;
  const title =
    selected.type === "node"
      ? asString(data.label, "Memory node")
      : `${asString(data.linkType, "edge")} ${asString(data.source)} -> ${asString(data.target)}`;

  return (
    <aside className="details-panel">
      <p className="eyebrow">{selected.type}</p>
      <h2>{title}</h2>
      {data.text && <p className="memory-text">{String(data.text)}</p>}
      <dl>
        {Object.entries(data).map(([key, value]) => (
          <React.Fragment key={key}>
            <dt>{key}</dt>
            <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </aside>
  );
}

function Legend({ kind }: { kind: ViewKind }) {
  const items =
    kind === "constellation"
      ? [
          ["semantic", "#c8a2a6"],
          ["entity", "#f6e3a5"],
          ["temporal", "#b7c0e0"],
          ["causal", "#0057ff"],
        ]
      : [["co-occurrence", "#f6e3a5"]];

  return (
    <div className="legend">
      {items.map(([label, color]) => (
        <span key={label}>
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function GraphCanvas({
  graph,
  kind,
  selected,
  onSelect,
}: {
  graph: GraphResponse;
  kind: ViewKind;
  selected?: SelectedItem;
  onSelect: (item: SelectedItem) => void;
}) {
  const nodes = useMemo(() => normalizeNodes(graph.nodes ?? [], graph.edges ?? []), [graph.nodes, graph.edges]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edges = graph.edges ?? [];
  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree));

  if (nodes.length === 0) {
    return (
      <section className="graph-empty">
        <h2>No graph data yet</h2>
        <p>Retain a few memories, then refresh this viewer.</p>
      </section>
    );
  }

  return (
    <section className="graph-card">
      <div className="graph-meta">
        <span>{graphSummary(graph)}</span>
        <Legend kind={kind} />
      </div>
      <svg className="graph-svg" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} role="img" aria-label={`${kind} graph`}>
        <g className="edges">
          {edges.map((edge, index) => {
            const source = byId.get(asString(edge.data.source));
            const target = byId.get(asString(edge.data.target));
            if (!source || !target || source.id === target.id) return null;
            const isSelected = selected?.type === "edge" && selected.value === edge;
            return (
              <line
                key={`${edgeKey(edge, index)}-${index}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={asString(edge.data.color, kind === "cooccurrence" ? "#f6e3a5" : "#b7c0e0")}
                strokeWidth={isSelected ? 4 : Math.max(1, Math.min(6, asNumber(edge.data.weight, 1)))}
                strokeOpacity={isSelected ? 0.95 : 0.38}
                strokeDasharray={edge.data.lineStyle === "dashed" ? "8 7" : undefined}
                onClick={() => onSelect({ type: "edge", value: edge })}
              />
            );
          })}
        </g>
        <g className="nodes">
          {nodes.map((node) => {
            const isSelected = selected?.type === "node" && selected.value.id === node.id;
            const radius = 11 + (node.degree / maxDegree) * 16;
            return (
              <g key={node.id} transform={`translate(${node.x} ${node.y})`} onClick={() => onSelect({ type: "node", value: node })}>
                <circle r={isSelected ? radius + 5 : radius + 2} fill="rgba(163, 131, 154, 0.2)" />
                <circle
                  r={radius}
                  fill={asString(node.data.color, "#a3839a")}
                  stroke={isSelected ? "#0057ff" : "rgba(13, 13, 13, 0.35)"}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                >
                  <title>{node.label}</title>
                </circle>
                <text y={radius + 18} textAnchor="middle">
                  {node.label.length > 28 ? `${node.label.slice(0, 28)}...` : node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </section>
  );
}

function GraphTables({
  graph,
  onSelect,
}: {
  graph: GraphResponse;
  onSelect: (item: SelectedItem) => void;
}) {
  const nodes = useMemo(() => normalizeNodes(graph.nodes ?? [], graph.edges ?? []), [graph.nodes, graph.edges]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edges = graph.edges ?? [];

  return (
    <section className="table-card">
      <div className="graph-meta">
        <span>{graphSummary(graph)}</span>
        <span>Tables show the raw Hindsight records behind the graph.</span>
      </div>

      <div className="table-section">
        <h2>Nodes</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Degree</th>
                <th>Mentions</th>
                <th>Entities</th>
                <th>Context</th>
                <th>Date</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id} onClick={() => onSelect({ type: "node", value: node })}>
                  <td className="primary-cell">{node.label}</td>
                  <td>{node.degree}</td>
                  <td>{tableCell(node.data.mentionCount)}</td>
                  <td>{tableCell(node.data.entities)}</td>
                  <td>{tableCell(node.data.context)}</td>
                  <td>{tableCell(node.data.date)}</td>
                  <td>{compactId(node.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="table-section">
        <h2>Edges</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Source</th>
                <th>Target</th>
                <th>Entity</th>
                <th>Weight</th>
                <th>Last seen</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge, index) => {
                const sourceId = asString(edge.data.source);
                const targetId = asString(edge.data.target);
                return (
                  <tr key={`${edgeKey(edge, index)}-${index}`} onClick={() => onSelect({ type: "edge", value: edge })}>
                    <td className="primary-cell">{tableCell(edge.data.linkType)}</td>
                    <td>{byId.get(sourceId)?.label ?? compactId(sourceId)}</td>
                    <td>{byId.get(targetId)?.label ?? compactId(targetId)}</td>
                    <td>{tableCell(edge.data.entityName)}</td>
                    <td>{tableCell(edge.data.weight)}</td>
                    <td>{tableCell(edge.data.lastCooccurred)}</td>
                    <td>{compactId(edge.data.id)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function App() {
  const [view, setView] = useState<ViewKind>("constellation");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("graph");
  const [limit, setLimit] = useState(250);
  const [minCount, setMinCount] = useState(1);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState<HindsightStatus>();
  const [graph, setGraph] = useState<GraphResponse>({});
  const [selected, setSelected] = useState<SelectedItem>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchJson<HindsightStatus>(`${API_BASE}/status`)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setStatus({ ok: false, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (view === "cooccurrence") {
      params.set("min_count", String(minCount));
    } else {
      if (query.trim()) params.set("q", query.trim());
      if (type) params.set("type", type);
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    setSelected(undefined);
    fetchJson<GraphResponse>(`${API_BASE}/graph/${view}?${params.toString()}`)
      .then((next) => {
        if (!cancelled) setGraph(next);
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
  }, [limit, minCount, query, refreshKey, type, view]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Joshu Memory</p>
          <h1>Memory</h1>
        </div>
        <div className={`status-pill ${status?.ok ? "status-ready" : "status-error"}`}>
          <span />
          {status?.ok ? `Bank: ${status.bankId ?? "unknown"}` : status?.error ?? "Checking Hindsight..."}
        </div>
      </header>

      <section className="controls">
        <div className="tabs">
          <button type="button" className={view === "constellation" ? "active" : ""} onClick={() => setView("constellation")}>
            Constellation
          </button>
          <button type="button" className={view === "cooccurrence" ? "active" : ""} onClick={() => setView("cooccurrence")}>
            Entity Co-occurrence
          </button>
        </div>

        <div className="tabs">
          <button type="button" className={displayMode === "graph" ? "active" : ""} onClick={() => setDisplayMode("graph")}>
            Graph
          </button>
          <button type="button" className={displayMode === "table" ? "active" : ""} onClick={() => setDisplayMode("table")}>
            Table
          </button>
        </div>

        <label>
          Limit
          <input type="number" min={10} max={1000} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
        </label>

        {view === "constellation" ? (
          <>
            <label>
              Search
              <input value={query} placeholder="Optional memory text search" onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label>
              Type
              <select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="">All</option>
                <option value="world">World</option>
                <option value="experience">Experience</option>
                <option value="opinion">Opinion</option>
              </select>
            </label>
          </>
        ) : (
          <label>
            Min count
            <input type="number" min={1} max={100} value={minCount} onChange={(event) => setMinCount(Number(event.target.value))} />
          </label>
        )}

        <button type="button" className="refresh-button" onClick={() => setRefreshKey((value) => value + 1)}>
          Refresh
        </button>
      </section>

      {error && <pre className="error-box">{error}</pre>}
      {loading ? (
        <section className="graph-empty">Loading graph...</section>
      ) : (
        <div className="viewer-grid">
          {displayMode === "graph" ? (
            <GraphCanvas graph={graph} kind={view} selected={selected} onSelect={setSelected} />
          ) : (
            <GraphTables graph={graph} onSelect={setSelected} />
          )}
          <DetailPanel selected={selected} />
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
