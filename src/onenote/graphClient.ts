import fs from "node:fs";
import path from "node:path";
import type { Dispatcher } from "undici";
import {
  listProxyPorts,
  proxyPortForWorker,
  redactProxyUrl,
  resolveOutboundProxyUrlForPort,
} from "../proxyConfig.js";
import type { ParsedOneNoteUrl } from "./parseUrl.js";
import { normalizeWdPageTitle } from "./parseUrl.js";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// Graph v2 device-code flow needs fully qualified resource scopes.
const DEVICE_CODE_SCOPE =
  "https://graph.microsoft.com/Notes.Read https://graph.microsoft.com/User.Read offline_access openid";

export type GraphNotebook = {
  id: string;
  displayName?: string;
};

export type GraphSection = {
  id: string;
  displayName?: string;
};

export type GraphPageResolveResult = {
  html: string;
  graphPageId: string;
  graphSectionId?: string;
  notebookName?: string;
  pageTitle?: string;
};

function encodeGraphId(id: string): string {
  return encodeURIComponent(id);
}

function isGraphOnenoteEntityId(id: string): boolean {
  return id.includes("!");
}

function normalizeLabel(value: string): string {
  return value
    .replace(/\.one$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pageMatchesHints(page: GraphPageMeta, hints: ParsedOneNoteUrl): boolean {
  const clientPageId = hints.pageId?.trim().toLowerCase();
  const title = hints.pageTitle?.trim()
    ? normalizeWdPageTitle(hints.pageTitle.trim())
    : undefined;
  const pageTitle = page.title?.trim();
  if (title && pageTitle?.toLowerCase() === title.toLowerCase()) return true;
  if (title && pageTitle?.toLowerCase().startsWith(title.slice(0, 24).toLowerCase())) return true;
  if (title && pageTitle && title.toLowerCase().startsWith(pageTitle.slice(0, 24).toLowerCase())) return true;
  if (!clientPageId) return false;
  const graphId = page.id.toLowerCase();
  const linkHaystack = [
    page.links?.oneNoteWebUrl?.href,
    page.links?.oneNoteClientUrl?.href,
    page.contentUrl,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    graphId === clientPageId ||
    graphId.includes(clientPageId) ||
    graphId.split("!").pop()?.includes(clientPageId) === true ||
    linkHaystack.includes(clientPageId)
  );
}

function pickNotebook(
  notebooks: GraphNotebook[],
  notebookName?: string,
): GraphNotebook | null {
  if (notebooks.length === 0) return null;
  const target = notebookName ? normalizeLabel(notebookName) : "";
  if (!target) return notebooks[0]!;
  return (
    notebooks.find((n) => normalizeLabel(n.displayName ?? "") === target) ??
    notebooks.find((n) => normalizeLabel(n.displayName ?? "").includes(target)) ??
    notebooks.find((n) => target.includes(normalizeLabel(n.displayName ?? ""))) ??
    null
  );
}

async function graphListPaged<T>(
  path: string,
  token: string,
  action: string,
): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = `${GRAPH_BASE}${path}`;

  while (nextUrl) {
    const res = await graphFetchAbsolute(nextUrl, token, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw await graphError(action, res);
    }
    const body = (await res.json()) as {
      value?: T[];
      "@odata.nextLink"?: string;
    };
    items.push(...(body.value ?? []));
    nextUrl = body["@odata.nextLink"] ?? null;
  }

  return items;
}

function orderNotebooksForSearch(
  notebooks: GraphNotebook[],
  notebookName?: string,
): GraphNotebook[] {
  const preferred = pickNotebook(notebooks, notebookName);
  if (!preferred) return notebooks;
  return [preferred, ...notebooks.filter((n) => n.id !== preferred.id)];
}

/** OneDrive wd=target uses `{Section Name}.one` — usually a Graph section, not notebook display name. */
function sectionNameHint(hints: ParsedOneNoteUrl): string | undefined {
  if (!hints.notebookName?.trim()) return undefined;
  return normalizeLabel(hints.notebookName);
}

function sectionMatchesHint(section: GraphSection, hint: string): boolean {
  const name = normalizeLabel(section.displayName ?? "");
  return name === hint || name.includes(hint) || hint.includes(name);
}

function orderSectionsForSearch(
  sections: GraphSection[],
  hint?: string,
): GraphSection[] {
  if (!hint) return sections;
  const matched = sections.filter((section) => sectionMatchesHint(section, hint));
  if (matched.length === 0) return sections;
  const rest = sections.filter((section) => !matched.includes(section));
  return [...matched, ...rest];
}

async function orderNotebooksBySectionHint(
  notebooks: GraphNotebook[],
  token: string,
  sectionHint?: string,
): Promise<GraphNotebook[]> {
  if (!sectionHint) return notebooks;
  const matched: GraphNotebook[] = [];
  const rest: GraphNotebook[] = [];
  for (const notebook of notebooks) {
    const sections = await listNotebookSections(notebook.id, token);
    if (sections.some((section) => sectionMatchesHint(section, sectionHint))) {
      matched.push(notebook);
    } else {
      rest.push(notebook);
    }
  }
  return matched.length > 0 ? [...matched, ...rest] : notebooks;
}

async function getSignedInUserLabel(token: string): Promise<string> {
  const res = await graphFetch("/me", token, { headers: { Accept: "application/json" } });
  if (!res.ok) return "this Microsoft account";
  const body = (await res.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
  return body.mail || body.userPrincipalName || body.displayName || "this Microsoft account";
}

const TOKEN_CACHE_PATH =
  process.env.MS_GRAPH_TOKEN_CACHE?.trim() ||
  path.join(process.cwd(), ".local", "ms-graph-token.json");

type CachedGraphToken = { accessToken: string; expiresAt: number };

function readCachedToken(): string | null {
  try {
    const raw = fs.readFileSync(TOKEN_CACHE_PATH, "utf8");
    const cached = JSON.parse(raw) as CachedGraphToken;
    if (cached.accessToken && cached.expiresAt > Date.now() + 60_000) {
      return cached.accessToken;
    }
  } catch {
    // no cache
  }
  return null;
}

function writeCachedToken(accessToken: string): void {
  try {
    const dir = path.dirname(TOKEN_CACHE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      TOKEN_CACHE_PATH,
      JSON.stringify({ accessToken, expiresAt: Date.now() + 50 * 60 * 1000 }, null, 2),
      "utf8",
    );
  } catch {
    // best-effort
  }
}

export type GraphPageMeta = {
  id: string;
  title?: string;
  contentUrl?: string;
  lastModifiedDateTime?: string;
  links?: {
    oneNoteWebUrl?: { href?: string };
    oneNoteClientUrl?: { href?: string };
  };
};

export type GraphAuthConfig = {
  accessToken?: string;
  clientId?: string;
  tenantId?: string;
};

let graphProxyLogged = false;
const graphProxyDispatchers = new Map<number, Dispatcher>();

async function graphFetchDispatcher(
  url: string,
  proxyPort?: number,
): Promise<Dispatcher | undefined> {
  if (!url.includes("graph.microsoft.com")) return undefined;

  const port = proxyPort ?? listProxyPorts()[0];
  if (port === undefined) return undefined;

  const cached = graphProxyDispatchers.get(port);
  if (cached) return cached;

  const proxyUrl = resolveOutboundProxyUrlForPort(port);
  if (!proxyUrl) return undefined;

  const { ProxyAgent } = await import("undici");
  const agent = new ProxyAgent(proxyUrl);
  graphProxyDispatchers.set(port, agent);
  if (!graphProxyLogged) {
    const ports = listProxyPorts();
    if (ports.length > 1) {
      console.error(
        `[onenote] Graph API via ${ports.length} proxies (ports ${ports[0]}–${ports[ports.length - 1]})`,
      );
    } else {
      console.error(`[onenote] Graph API via proxy ${redactProxyUrl(proxyUrl)}`);
    }
    graphProxyLogged = true;
  }
  return agent;
}

type GraphRequestOpts = { proxyPort?: number };

async function graphFetchAbsolute(
  url: string,
  token: string,
  init: RequestInit = {},
  reqOpts: GraphRequestOpts = {},
): Promise<Response> {
  const maxRetries = 8;
  let attempt = 0;
  const dispatcher = await graphFetchDispatcher(url, reqOpts.proxyPort);

  while (true) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(url, {
      ...init,
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (res.status !== 429 || attempt >= maxRetries) return res;

    const retryAfterSec = Number(res.headers.get("Retry-After") || 0);
    const waitMs =
      (retryAfterSec > 0 ? retryAfterSec * 1000 : 5000 * 2 ** attempt) +
      Math.floor(Math.random() * 1000);
    const label = url.replace(GRAPH_BASE, "").slice(0, 72);
    console.error(`[onenote] rate limited on ${label} — waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    attempt++;
  }
}

async function graphFetch(
  path: string,
  token: string,
  init: RequestInit = {},
  reqOpts: GraphRequestOpts = {},
): Promise<Response> {
  return graphFetchAbsolute(`${GRAPH_BASE}${path}`, token, init, reqOpts);
}

/** Personal-account-only apps must use the /consumers endpoint, not /common. */
const CONSUMERS_TENANT_REQUIRED = /AADSTS9002346|use the \/consumers endpoint/i;

function resolveGraphTenants(config: GraphAuthConfig): string[] {
  const explicit = config.tenantId?.trim();
  if (explicit) return [explicit];
  // Try common first (works for multi-tenant apps), then consumers (personal MSA-only apps).
  return ["common", "consumers"];
}

async function requestDeviceCode(
  clientId: string,
  tenant: string,
): Promise<{
  device_code: string;
  user_code?: string;
  verification_uri?: string;
  message?: string;
  interval?: number;
  expires_in?: number;
}> {
  const deviceRes = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope: DEVICE_CODE_SCOPE,
      }),
    },
  );
  const device = (await deviceRes.json()) as {
    error?: string;
    error_description?: string;
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    message?: string;
    interval?: number;
    expires_in?: number;
  };
  if (!deviceRes.ok || !device.device_code) {
    const detail = device.error_description || device.error || String(deviceRes.status);
    const err = new Error(detail);
    (err as Error & { tenant?: string }).tenant = tenant;
    throw err;
  }
  return {
    device_code: device.device_code,
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    message: device.message,
    interval: device.interval,
    expires_in: device.expires_in,
  };
}

async function pollDeviceCodeToken(
  clientId: string,
  tenant: string,
  deviceCode: string,
  intervalSec = 5,
  expiresInSec = 900,
): Promise<string> {
  const intervalMs = intervalSec * 1000;
  const deadline = Date.now() + expiresInSec * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: clientId,
          device_code: deviceCode,
        }),
      },
    );
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (tokenBody.access_token) return tokenBody.access_token;
    if (tokenBody.error !== "authorization_pending" && tokenBody.error !== "slow_down") {
      throw new Error(
        `Token request failed: ${tokenBody.error_description || tokenBody.error || tokenRes.status}`,
      );
    }
  }

  throw new Error("Device code login timed out.");
}

/** Device-code login when no cached access token is available. */
export async function acquireGraphAccessToken(config: GraphAuthConfig): Promise<string> {
  if (config.accessToken?.trim()) return config.accessToken.trim();

  const cached = readCachedToken();
  if (cached) {
    console.error("[onenote] using cached Graph token (.local/ms-graph-token.json)");
    return cached;
  }

  const clientId = config.clientId?.trim();
  if (!clientId) {
    throw new Error(
      "Set MS_GRAPH_ACCESS_TOKEN or MS_GRAPH_CLIENT_ID.\n" +
        "Quick token (Azure CLI): az login && az account get-access-token " +
        '--resource https://graph.microsoft.com --scope "Notes.Read"',
    );
  }

  const tenants = resolveGraphTenants(config);
  let lastError: Error | null = null;

  for (let i = 0; i < tenants.length; i++) {
    const tenant = tenants[i]!;
    try {
      const device = await requestDeviceCode(clientId, tenant);
      console.error(
        device.message || `Open ${device.verification_uri} and enter ${device.user_code}`,
      );
      console.error(
        "[onenote] sign in with the Microsoft account that owns the OneDrive notebook (not a different personal account).",
      );
      const token = await pollDeviceCodeToken(
        clientId,
        tenant,
        device.device_code,
        device.interval ?? 5,
        device.expires_in ?? 900,
      );
      writeCachedToken(token);
      const who = await getSignedInUserLabel(token);
      console.error(`[onenote] signed in as ${who}`);
      return token;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      const hasNextTenant = i < tenants.length - 1;
      if (hasNextTenant && CONSUMERS_TENANT_REQUIRED.test(error.message)) {
        console.error("[onenote] personal Microsoft account app — retrying login via /consumers endpoint");
        continue;
      }
      throw new Error(
        `Device code request failed: ${error.message}` +
          (CONSUMERS_TENANT_REQUIRED.test(error.message)
            ? "\nSet MS_GRAPH_TENANT_ID=consumers for personal-account-only app registrations."
            : ""),
      );
    }
  }

  throw lastError ?? new Error("Device code login failed");
}

export async function getPageMeta(pageId: string, token: string): Promise<GraphPageMeta> {
  const res = await graphFetch(`/me/onenote/pages/${encodeGraphId(pageId)}`, token, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw await graphError("get page metadata", res);
  }
  return (await res.json()) as GraphPageMeta;
}

export async function getPageHtml(
  pageId: string,
  token: string,
  opts: { includeIds?: boolean; maxRetries?: number; proxyPort?: number } = {},
): Promise<string> {
  const qs = opts.includeIds ? "?includeIDs=true" : "";
  const maxRetries = opts.maxRetries ?? 6;
  let attempt = 0;

  while (true) {
    const res = await graphFetch(
      `/me/onenote/pages/${encodeGraphId(pageId)}/content${qs}`,
      token,
      { headers: { Accept: "text/html" } },
      { proxyPort: opts.proxyPort },
    );
    if (res.ok) return res.text();
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterSec = Number(res.headers.get("Retry-After") || 0);
      const waitMs =
        (retryAfterSec > 0 ? retryAfterSec * 1000 : 3000 * 2 ** attempt) +
        Math.floor(Math.random() * 500);
      console.error(`[onenote] rate limited — waiting ${Math.round(waitMs / 1000)}s (page ${pageId.slice(-12)})`);
      await sleep(waitMs);
      attempt++;
      continue;
    }
    throw await graphError("get page HTML", res);
  }
}

export async function listSectionPages(
  sectionId: string,
  token: string,
): Promise<GraphPageMeta[]> {
  return graphListPaged<GraphPageMeta>(
    `/me/onenote/sections/${encodeGraphId(sectionId)}/pages`,
    token,
    "list section pages",
  );
}

/** Walk section pages page-by-page; stop as soon as a hint matches (avoids loading huge sections). */
async function findPageInSection(
  sectionId: string,
  token: string,
  hints: ParsedOneNoteUrl,
): Promise<GraphPageMeta | null> {
  const title = hints.pageTitle?.trim()
    ? normalizeWdPageTitle(hints.pageTitle.trim())
    : undefined;
  const paths: string[] = [];
  if (title && title.length >= 8) {
    const escaped = title.slice(0, 24).replace(/'/g, "''");
    paths.push(
      `/me/onenote/sections/${encodeGraphId(sectionId)}/pages?$filter=contains(title,'${escaped}')`,
    );
  }
  paths.push(`/me/onenote/sections/${encodeGraphId(sectionId)}/pages`);

  for (const path of paths) {
    let nextUrl: string | null = `${GRAPH_BASE}${path}`;
    while (nextUrl) {
      const res = await graphFetchAbsolute(nextUrl, token, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        if (path.includes("$filter") && res.status === 400) break;
        throw await graphError("list section pages", res);
      }
      const body = (await res.json()) as {
        value?: GraphPageMeta[];
        "@odata.nextLink"?: string;
      };
      for (const page of body.value ?? []) {
        if (pageMatchesHints(page, hints)) return page;
      }
      nextUrl = body["@odata.nextLink"] ?? null;
    }
  }

  return null;
}

async function graphError(action: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as {
      error?: { message?: string; code?: string; innerError?: unknown };
    };
    const parts = [body.error?.message, body.error?.code].filter(Boolean);
    if (body.error?.innerError) {
      parts.push(JSON.stringify(body.error.innerError));
    }
    detail = parts.join(" — ") || JSON.stringify(body);
  } catch {
    detail = await res.text().catch(() => "");
  }
  return new Error(`Failed to ${action} (${res.status}): ${detail || res.statusText}`);
}

/** OneDrive web URLs use client GUIDs; discover the real Graph page via notebook + title. */
export async function fetchGraphPageHtml(
  token: string,
  hints: ParsedOneNoteUrl,
  opts: { includeIds?: boolean } = {},
): Promise<GraphPageResolveResult> {
  const clientPageId = hints.pageId?.trim();

  if (clientPageId && isGraphOnenoteEntityId(clientPageId)) {
    const html = await getPageHtml(clientPageId, token, opts);
    return { html, graphPageId: clientPageId, pageTitle: hints.pageTitle };
  }

  if (clientPageId) {
    const metaRes = await graphFetch(`/me/onenote/pages/${encodeGraphId(clientPageId)}`, token, {
      headers: { Accept: "application/json" },
    });
    if (metaRes.ok) {
      const html = await getPageHtml(clientPageId, token, opts);
      return { html, graphPageId: clientPageId, pageTitle: hints.pageTitle };
    }
  }

  const notebooks = await listNotebooks(token);
  const who = await getSignedInUserLabel(token);
  if (notebooks.length === 0) {
    throw new Error(
      `No OneNote notebooks found for ${who}.\n` +
        "Sign in with the same Microsoft account that opens this OneDrive link in your browser.",
    );
  }

  const sectionHint = sectionNameHint(hints);
  let notebookOrder = orderNotebooksForSearch(notebooks, hints.notebookName);
  if (sectionHint && !pickNotebook(notebooks, hints.notebookName)) {
    notebookOrder = await orderNotebooksBySectionHint(notebookOrder, token, sectionHint);
  }
  console.error(
    `[onenote] discovering page across ${notebookOrder.length} notebook(s) for ${who}…` +
      (sectionHint ? ` (section hint: ${sectionHint})` : ""),
  );

  for (const notebook of notebookOrder) {
    console.error(`[onenote] scanning notebook: ${notebook.displayName ?? notebook.id}`);
    const sections = orderSectionsForSearch(
      await listNotebookSections(notebook.id, token),
      sectionHint,
    );
    console.error(`[onenote]   ${sections.length} section(s)`);

    const sectionCandidates =
      hints.sectionId && isGraphOnenoteEntityId(hints.sectionId)
        ? sections.filter((section) => section.id === hints.sectionId)
        : sections;

    for (const section of sectionCandidates) {
      console.error(`[onenote]   section: ${section.displayName ?? section.id}`);
      const match = await findPageInSection(section.id, token, hints);
      if (match) {
        console.error(`[onenote]     matched page: ${match.title ?? match.id}`);
        const html = await getPageHtml(match.id, token, opts);
        return {
          html,
          graphPageId: match.id,
          graphSectionId: section.id,
          notebookName: notebook.displayName,
          pageTitle: match.title ?? hints.pageTitle,
        };
      }
    }
  }

  const names = notebooks.map((n) => n.displayName ?? n.id).join(", ");
  const wanted = sectionHint
    ? `section "${sectionHint}"`
    : hints.notebookName
      ? `"${hints.notebookName}"`
      : "the target notebook";
  throw new Error(
    `Could not find page${hints.pageTitle ? ` "${normalizeWdPageTitle(hints.pageTitle)}"` : ""} ` +
      `in ${wanted} for ${who}.\n` +
      `Notebooks visible to this account: ${names}\n` +
      "Use the Microsoft account that owns the OneDrive URL, or run: npm run onenote:fetch-page -- --graph-only --list-notebooks",
  );
}

/** @deprecated Use fetchGraphPageHtml — web section ids are not Graph entity ids. */
export async function resolveGraphPageId(
  token: string,
  opts: { pageId: string; sectionId?: string; pageTitle?: string; notebookName?: string },
): Promise<string> {
  const result = await fetchGraphPageHtml(
    token,
    {
      pageId: opts.pageId,
      sectionId: opts.sectionId,
      pageTitle: opts.pageTitle,
      notebookName: opts.notebookName,
    },
    {},
  );
  return result.graphPageId;
}

export async function listNotebooks(token: string): Promise<GraphNotebook[]> {
  const res = await graphFetch("/me/onenote/notebooks", token, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw await graphError("list notebooks", res);
  }
  const body = (await res.json()) as { value?: GraphNotebook[] };
  return body.value ?? [];
}

export async function listNotebookSections(
  notebookId: string,
  token: string,
): Promise<GraphSection[]> {
  const res = await graphFetch(
    `/me/onenote/notebooks/${encodeGraphId(notebookId)}/sections`,
    token,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw await graphError("list notebook sections", res);
  }
  const body = (await res.json()) as { value?: GraphSection[] };
  return body.value ?? [];
}

export type ResolvedGraphSection = {
  notebook: GraphNotebook;
  section: GraphSection;
};

/** Resolve a Graph section from URL hints or an explicit Graph section id (`…!…`). */
export async function resolveGraphSection(
  token: string,
  hints: ParsedOneNoteUrl,
  explicitSectionId?: string,
): Promise<ResolvedGraphSection> {
  const graphSectionId =
    explicitSectionId?.includes("!") ? explicitSectionId
    : hints.sectionId?.includes("!") ? hints.sectionId
    : undefined;

  if (graphSectionId) {
    const notebooks = await listNotebooks(token);
    for (const notebook of notebooks) {
      const sections = await listNotebookSections(notebook.id, token);
      const section = sections.find((s) => s.id === graphSectionId);
      if (section) return { notebook, section };
    }
    throw new Error(`Graph section not found: ${graphSectionId}`);
  }

  const sectionHint = sectionNameHint(hints);
  if (!sectionHint) {
    throw new Error(
      "Could not resolve section — pass --url with a wd=target(...Section.one...) link, " +
        "or --section-id with a Graph section id (contains !).",
    );
  }

  const notebooks = await listNotebooks(token);
  const who = await getSignedInUserLabel(token);
  if (notebooks.length === 0) {
    throw new Error(`No OneNote notebooks found for ${who}`);
  }

  let notebookOrder = orderNotebooksForSearch(notebooks, hints.notebookName);
  if (!pickNotebook(notebooks, hints.notebookName)) {
    notebookOrder = await orderNotebooksBySectionHint(notebookOrder, token, sectionHint);
  }

  for (const notebook of notebookOrder) {
    const sections = orderSectionsForSearch(
      await listNotebookSections(notebook.id, token),
      sectionHint,
    );
    const section = sections.find((s) => sectionMatchesHint(s, sectionHint));
    if (section) return { notebook, section };
  }

  const names = notebooks.map((n) => n.displayName ?? n.id).join(", ");
  throw new Error(
    `Could not find section "${sectionHint}" for ${who}. Notebooks: ${names}`,
  );
}

export type SectionDumpManifestEntry = {
  index: number;
  title?: string;
  graphPageId: string;
  file: string;
  bytes?: number;
  lastModifiedDateTime?: string;
  error?: string;
};

export type SectionDumpResult = {
  outputDir: string;
  notebookName?: string;
  sectionName?: string;
  graphSectionId: string;
  total: number;
  written: number;
  failed: number;
  manifestPath: string;
};

function safePageFileName(title: string | undefined, index: number): string {
  const base =
    (title ?? "untitled")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "untitled";
  return `${String(index).padStart(4, "0")} - ${base}.html`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number, workerId: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(workerId: number): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i, workerId);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, (_, workerId) => worker(workerId)));
  return results;
}

function defaultDumpConcurrency(): number {
  const ports = listProxyPorts();
  if (ports.length > 1) return Math.min(ports.length, 4);
  return 2;
}

/** Download HTML for every page in a section into outputDir (plus manifest.json). */
export async function dumpGraphSectionHtml(
  token: string,
  opts: {
    hints: ParsedOneNoteUrl;
    outputDir: string;
    sectionId?: string;
    includeIds?: boolean;
    concurrency?: number;
    resume?: boolean;
    requestDelayMs?: number;
    onProgress?: (done: number, total: number, page: GraphPageMeta) => void;
  },
): Promise<SectionDumpResult> {
  const { notebook, section } = await resolveGraphSection(token, opts.hints, opts.sectionId);
  const pages = await listSectionPages(section.id, token);
  const outputDir = path.resolve(opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  console.error(
    `[onenote] dumping ${pages.length} page(s) from "${section.displayName}" ` +
      `in "${notebook.displayName}" → ${outputDir}`,
  );

  const concurrency = opts.concurrency ?? defaultDumpConcurrency();
  const requestDelayMs = opts.requestDelayMs ?? 250;
  let done = 0;
  let skipped = 0;
  const manifest: SectionDumpManifestEntry[] = await mapPool(
    pages,
    concurrency,
    async (page, index, workerId) => {
      const fileName = safePageFileName(page.title, index + 1);
      const filePath = path.join(outputDir, fileName);
      const entry: SectionDumpManifestEntry = {
        index: index + 1,
        title: page.title,
        graphPageId: page.id,
        file: fileName,
        lastModifiedDateTime: page.lastModifiedDateTime,
      };
      try {
        if (opts.resume && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
          entry.bytes = fs.statSync(filePath).size;
          skipped++;
        } else {
          if (requestDelayMs > 0) await sleep(requestDelayMs);
          const html = await getPageHtml(page.id, token, {
            includeIds: opts.includeIds,
            proxyPort: proxyPortForWorker(workerId),
          });
          fs.writeFileSync(filePath, html, "utf8");
          entry.bytes = html.length;
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
      done++;
      opts.onProgress?.(done, pages.length, page);
      if (done % 25 === 0 || done === pages.length) {
        console.error(`[onenote]   ${done}/${pages.length} pages`);
      }
      return entry;
    },
  );

  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        notebook: notebook.displayName,
        notebookId: notebook.id,
        section: section.displayName,
        sectionId: section.id,
        total: pages.length,
        written: manifest.filter((e) => !e.error).length,
        failed: manifest.filter((e) => e.error).length,
        pages: manifest,
      },
      null,
      2,
    ),
    "utf8",
  );

  const written = manifest.filter((e) => !e.error).length;
  const failed = manifest.filter((e) => e.error).length;
  console.error(
    `[onenote] done — ${written} written, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} skipped (resume)` : "") +
      ` → ${manifestPath}`,
  );

  return {
    outputDir,
    notebookName: notebook.displayName,
    sectionName: section.displayName,
    graphSectionId: section.id,
    total: pages.length,
    written,
    failed,
    manifestPath,
  };
}

type ManifestFile = {
  exportedAt?: string;
  notebook?: string;
  notebookId?: string;
  section?: string;
  sectionId?: string;
  total?: number;
  written?: number;
  failed?: number;
  pages: SectionDumpManifestEntry[];
};

/** Re-fetch only failed/missing pages using an existing manifest (no Graph list calls). */
export async function resumeGraphSectionDumpFromManifest(
  token: string,
  opts: {
    outputDir: string;
    includeIds?: boolean;
    requestDelayMs?: number;
    concurrency?: number;
  },
): Promise<SectionDumpResult> {
  const outputDir = path.resolve(opts.outputDir);
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ManifestFile;
  const pages = manifest.pages ?? [];
  let skipped = 0;
  for (const entry of pages) {
    const filePath = path.join(outputDir, entry.file);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      entry.bytes = fs.statSync(filePath).size;
      delete entry.error;
      skipped++;
    }
  }
  const pending = pages.filter((entry) => {
    const filePath = path.join(outputDir, entry.file);
    return !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;
  });

  manifest.written = pages.filter((p) => !p.error).length;
  manifest.failed = pages.filter((p) => p.error).length;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.error(
    `[onenote] resuming ${pending.length}/${pages.length} pending page(s)` +
      ` (${skipped} already on disk, skipped) → ${manifestPath}`,
  );

  const requestDelayMs = opts.requestDelayMs ?? 8000;
  const concurrency = opts.concurrency ?? defaultDumpConcurrency();
  const proxyPorts = listProxyPorts();
  console.error(
    `[onenote] ${concurrency} parallel worker(s)` +
      (proxyPorts.length > 1
        ? `, proxy ports: ${proxyPorts.slice(0, concurrency).join(", ")}`
        : "") +
      `, ${requestDelayMs}ms delay per worker`,
  );

  let done = 0;
  let okAtStart = pages.filter((p) => !p.error).length;
  let manifestWriteQueue = Promise.resolve();

  const scheduleManifestCheckpoint = (): void => {
    manifestWriteQueue = manifestWriteQueue.then(() => {
      const written = pages.filter((p) => !p.error).length;
      manifest.written = written;
      manifest.failed = pages.filter((p) => p.error).length;
      manifest.exportedAt = new Date().toISOString();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      const newOk = written - okAtStart;
      console.error(
        `[onenote]   resume ${done}/${pending.length} — ${written} total ok (+${newOk} this run)`,
      );
    });
  };

  await mapPool(pending, concurrency, async (entry, _index, workerId) => {
    if (requestDelayMs > 0) await sleep(requestDelayMs);
    const filePath = path.join(outputDir, entry.file);
    try {
      const html = await getPageHtml(entry.graphPageId, token, {
        includeIds: opts.includeIds,
        proxyPort: proxyPortForWorker(workerId),
      });
      fs.writeFileSync(filePath, html, "utf8");
      entry.bytes = html.length;
      delete entry.error;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    done++;
    if (done % 10 === 0 || done === pending.length) {
      scheduleManifestCheckpoint();
    }
  });

  await manifestWriteQueue;

  const written = pages.filter((p) => !p.error).length;
  const failed = pages.filter((p) => p.error).length;
  console.error(`[onenote] resume done — ${written} written, ${failed} failed → ${manifestPath}`);

  return {
    outputDir,
    notebookName: manifest.notebook,
    sectionName: manifest.section,
    graphSectionId: manifest.sectionId ?? "",
    total: pages.length,
    written,
    failed,
    manifestPath,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
