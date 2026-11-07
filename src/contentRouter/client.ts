/**
 * The client of the content router (change content-router, design decision D2): the router call
 * route and the public catalog routes of the control plane. A fleet box authenticates with its
 * agent token, and a self-hosted box with the router API key that the owner saved in Connectors.
 * The client runs in the Joshu API and never in Hermes, so the agent token stays out of the
 * Hermes environment. No call retries, and each call has a time limit.
 */

import {
  getMeteredProviderDefinition,
  instanceAgentBearerToken,
  resolveMeteredProviderApiKey,
  resolveMeteredProviderMode,
  resolveMeteredProviderUserEnabled,
} from "../meteredProviders/config.js";
import { provisionEnvTrim } from "../provisionInstanceEnv.js";

/** Base URL of the content router when the box names no control plane. */
export const DEFAULT_ROUTER_BASE_URL = "https://hello.joshu.me";

/** Time limit of one router call. The deadline of the caller can make it shorter. */
export const ROUTER_CALL_TIMEOUT_MS = 60_000;
/** Time limit of one catalog call. */
export const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Why a router call failed. The caller shows each kind as "could not be reached". The kind
 * `usage wallet empty` is HTTP 402: the usage wallet of the owner is too low for the call.
 */
export type RouterFailure =
  | "error"
  | "rate limited"
  | "timed out"
  | "usage wallet empty"
  | "unauthorized"
  | "unknown endpoint"
  | "provider error"
  | "no channel available";

export const USAGE_WALLET_EMPTY: RouterFailure = "usage wallet empty";

export class RouterError extends Error {
  readonly kind: RouterFailure;
  /** The HTTP status of the provider, for kind `provider error`. */
  readonly providerStatus?: number;
  constructor(kind: RouterFailure, message: string, providerStatus?: number) {
    super(message);
    this.name = "RouterError";
    this.kind = kind;
    if (providerStatus !== undefined) this.providerStatus = providerStatus;
  }
}

/** How this box reaches the content router. */
export type RouterAuth = {
  kind: "agent token" | "router API key";
  bearer: string;
  /** For example `https://hello.joshu.me`. */
  baseUrl: string;
};

/** Why this box cannot call the content router. The source list shows it. */
export type RouterUnavailable = "no router API key" | "content router off" | "no agent token";

/** The provision file first (the instance agent updates it at runtime), then the process env. */
function setting(name: string): string {
  return provisionEnvTrim(name) || process.env[name]?.trim() || "";
}

/**
 * The authentication of this box: the agent token in relay mode (fleet box), the router API key in
 * direct mode (self-hosted box), or the reason why the box cannot call the content router.
 */
export function resolveRouterAuth(projectRoot = process.cwd()): { auth: RouterAuth } | { auth: null; reason: RouterUnavailable } {
  const def = getMeteredProviderDefinition("router");
  if (!def) return { auth: null, reason: "content router off" };
  const mode = resolveMeteredProviderMode(def);
  if (mode === "off" || !resolveMeteredProviderUserEnabled(def, projectRoot)) {
    // A self-hosted box without a key is "not enabled" too; name the missing key.
    if (mode === "direct" && !resolveMeteredProviderApiKey(def, projectRoot)) return { auth: null, reason: "no router API key" };
    return { auth: null, reason: "content router off" };
  }
  const override = setting("JOSHU_ROUTER_URL");
  if (mode === "relay") {
    let bearer: string;
    try {
      bearer = instanceAgentBearerToken();
    } catch {
      return { auth: null, reason: "no agent token" };
    }
    const baseUrl = (override || setting("CONTROL_PLANE_URL") || DEFAULT_ROUTER_BASE_URL).replace(/\/+$/, "");
    return { auth: { kind: "agent token", bearer, baseUrl } };
  }
  const key = resolveMeteredProviderApiKey(def, projectRoot);
  if (!key) return { auth: null, reason: "no router API key" };
  return { auth: { kind: "router API key", bearer: key, baseUrl: (override || DEFAULT_ROUTER_BASE_URL).replace(/\/+$/, "") } };
}

/** One provider endpoint in the router catalog. */
export type EndpointSummary = {
  id: string;
  provider: string;
  provider_slug: string;
  title: string;
  capabilities: string[];
  price_usd: number | null;
  price_varies: boolean;
  channels: string[];
  served_via: string;
  success_rate_30d: number | null;
  median_latency_ms_30d: number | null;
  calls_30d: number;
};

export type EndpointDetail = EndpointSummary & {
  inputs: Record<string, unknown>;
  example_reply: unknown;
  offers: { channel: string; price_usd: number | null; price_varies: boolean; available: boolean }[];
  checked_at: string;
};

export type Capability = { id: string; title: string; description: string; kind: "data" | "media" };

export type CatalogSearchReply = {
  query: string;
  checked_at: string;
  markup_percent: number;
  capabilities: (Capability & { endpoints: EndpointSummary[] })[];
};

export type RouterCallRequest = {
  /** A provider endpoint id, or `auto` with a capability. */
  endpoint: string;
  capability?: string;
  params: Record<string, unknown>;
};

export type RouterCallReply = {
  call_id: string;
  endpoint: string;
  capability: string;
  channel: string;
  cost_usd: number;
  /** The reply of the provider, without the envelope of the channel. */
  body: unknown;
};

export type RouterClient = {
  /** One router call. `timeoutMs` replaces the time limit of one call, for example for a video. */
  call(request: RouterCallRequest, deadline: number, opts?: { timeoutMs?: number }): Promise<RouterCallReply>;
  search(q: string, limit: number, deadline: number): Promise<CatalogSearchReply>;
  /** The provider endpoint, or null when the router catalog does not have it. */
  endpoint(id: string, deadline: number): Promise<EndpointDetail | null>;
};

function remainingMs(deadline: number, limit: number): number {
  return Math.min(limit, deadline - Date.now());
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The failure of an answer that is not HTTP 200. */
function failureOf(status: number, body: unknown, what: string): RouterError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code = typeof b.error === "string" ? b.error : "";
  if (status === 402) return new RouterError(USAGE_WALLET_EMPTY, `${what}: the usage wallet is empty`);
  if (status === 429) return new RouterError("rate limited", `${what}: rate limited${b.retry_after_seconds ? `, retry after ${b.retry_after_seconds} seconds` : ""}`);
  if (status === 401 || status === 403) return new RouterError("unauthorized", `${what}: ${code || `HTTP ${status}`}`);
  if (status === 404) return new RouterError("unknown endpoint", `${what}: ${code || "not found"}`);
  if (status === 502) {
    const providerStatus = typeof b.status === "number" ? b.status : undefined;
    return new RouterError("provider error", `${what}: the provider answered ${providerStatus ?? "an error"}`, providerStatus);
  }
  if (status === 503) return new RouterError("no channel available", `${what}: no channel available`);
  return new RouterError("error", `${what}: HTTP ${status}${typeof b.message === "string" ? ` (${b.message})` : ""}`);
}

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, ms: number, what: string): Promise<Response> {
  if (ms <= 0) throw new RouterError("timed out", `${what}: no time left`);
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new RouterError("timed out", `${what} ran longer than ${Math.round(ms / 1000)} seconds`);
    throw new RouterError("error", `${what}: ${(err as Error).message}`);
  }
}

/** The client of the content router for `auth`. Tests pass a fake fetch. */
export function routerClient(auth: RouterAuth, fetchImpl: typeof fetch = fetch): RouterClient {
  const headers = { Authorization: `Bearer ${auth.bearer}`, Accept: "application/json" };
  const base = `${auth.baseUrl}/api/router`;
  return {
    async call(request, deadline, opts = {}) {
      const what = `router call ${request.endpoint}`;
      const res = await send(
        fetchImpl,
        `${base}/call`,
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(request) },
        remainingMs(deadline, opts.timeoutMs ?? ROUTER_CALL_TIMEOUT_MS),
        what,
      );
      const body = await readJson(res);
      if (!res.ok) throw failureOf(res.status, body, what);
      if (!body || typeof body !== "object" || !("body" in body)) throw new RouterError("error", `${what}: the answer has no body`);
      return body as RouterCallReply;
    },
    async search(q, limit, deadline) {
      const what = "router catalog search";
      const qs = new URLSearchParams({ q, limit: String(limit) }).toString();
      const res = await send(fetchImpl, `${base}/catalog/search?${qs}`, { method: "GET", headers }, remainingMs(deadline, CATALOG_TIMEOUT_MS), what);
      const body = await readJson(res);
      if (!res.ok) throw failureOf(res.status, body, what);
      const reply = (body ?? {}) as Partial<CatalogSearchReply>;
      return { query: q, checked_at: "", markup_percent: 0, ...reply, capabilities: Array.isArray(reply.capabilities) ? reply.capabilities : [] };
    },
    async endpoint(id, deadline) {
      const what = `router catalog endpoint ${id}`;
      const res = await send(
        fetchImpl,
        `${base}/catalog/endpoints/${encodeURIComponent(id)}`,
        { method: "GET", headers },
        remainingMs(deadline, CATALOG_TIMEOUT_MS),
        what,
      );
      const body = await readJson(res);
      if (res.status === 404) return null;
      if (!res.ok) throw failureOf(res.status, body, what);
      const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
      return endpoint && typeof endpoint === "object" ? (endpoint as EndpointDetail) : null;
    },
  };
}

/** The client of this box, or the reason why the box cannot call the content router. */
export function boxRouterClient(
  projectRoot = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): { client: RouterClient; auth: RouterAuth } | { client: null; reason: RouterUnavailable } {
  const resolved = resolveRouterAuth(projectRoot);
  if (!resolved.auth) return { client: null, reason: resolved.reason };
  return { client: routerClient(resolved.auth, fetchImpl), auth: resolved.auth };
}
