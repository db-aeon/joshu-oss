/**
 * The You.com client of the research pipeline (changes research-web-provider and
 * you-web-provider). It has the interface of the Exa client, so `searchWeb`, the recurring
 * reports, and the web routes of the companion use it in place of the Exa client.
 *
 * A fleet box holds no You.com key. In relay mode (`JOSHU_YOU_MODE=relay`) the box sends each
 * You.com call to the proxy of the control plane with its instance agent token, and the control
 * plane adds the key. A self-hosted box can set its own key (`YDC_API_KEY`) and call You.com
 * directly. Both ways make the same two calls: the web search with `POST /v1/search`, and the
 * full text of a page with `POST /v1/extract`.
 *
 * When a call fails and the box has an Exa key, the Exa client answers that call. You.com has no
 * call that returns the passages of a page for a question, so those passages stay on Exa.
 *
 * A box with no You.com access can still reach the You.com search through the content router,
 * endpoint `you.web.search.highlights`, when a report asks for You.com. The router has no You.com
 * endpoint for the full text of a page, so `contents` stays on Exa there.
 */

import { boxRouterClient, RouterError, type RouterClient, type RouterUnavailable } from "../../contentRouter/client.js";
import { instanceAgentBearerToken } from "../../meteredProviders/config.js";
import { provisionEnvTrim } from "../../provisionInstanceEnv.js";
import { exaClient, type ExaClient, type ExaResult, type ExaSearchRequest } from "./exa.js";
import { mapLimit } from "./llm.js";

export const YOU_SEARCH_ENDPOINT = "you.web.search.highlights";
const CALL_TIMEOUT_MS = 30_000;

const YOU_BASE = "https://ydc-index.io";
/** One box reads at most this many pages from You.com at once. */
export const YOU_EXTRACT_CONCURRENCY = 4;
/** The longest text of one page, as with Exa. */
const PAGE_TEXT_MAX_CHARS = 12_000;
const PAGE_PICTURES_MAX = 8;
/** The page calls of one `contents` call end this long before the deadline of the caller. */
const DEADLINE_MARGIN_MS = 1500;
/**
 * With an Exa client as the fallback, You.com gets at most this long for a search and for the
 * pages of one `contents` call. So a You.com call that hangs leaves time for Exa within the
 * limit of the caller.
 */
const YOU_SEARCH_FIRST_TRY_MS = 12_000;
const YOU_PAGES_FIRST_TRY_MS = 20_000;
/** Exa is not called for the missed pages when less time than this is left. */
const EXA_PAGES_MIN_MS = 2000;

/** The web search provider of a Research report. */
export type WebProvider = "exa" | "you.com";
export const WEB_PROVIDERS: readonly WebProvider[] = ["exa", "you.com"];

/**
 * The provider for a value from a request: "default" when the request names none (the box
 * chooses, see `boxWebClient`), or null when the value is not a known provider.
 */
export function parseWebProvider(value: unknown): WebProvider | "default" | null {
  if (value === undefined || value === null || value === "") return "default";
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "") return "default";
  if (v === "exa") return "exa";
  if (v === "you.com" || v === "you" || v === "youcom") return "you.com";
  return null;
}

/** The label of the web source in the source list of a report, for example "Web (You.com)". */
export function webSourceLabel(provider: WebProvider): string {
  return provider === "you.com" ? "Web (You.com)" : "Web (Exa)";
}

function utcDay(value: string | number | Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * The router params of one search. You.com takes a date range as `YYYY-MM-DDtoYYYY-MM-DD` and the
 * excluded sites as a list (a comma-separated string gets HTTP 400 from You.com). The router only
 * accepts the highlights extraction. You.com has no highlights query, so `highlightsQuery` is not sent.
 */
export function youSearchParams(req: ExaSearchRequest, now: Date = new Date()): Record<string, unknown> {
  return {
    query: req.query,
    count: req.numResults ?? 10,
    ...(req.startPublishedDate ? { freshness: `${utcDay(req.startPublishedDate)}to${utcDay(now)}` } : {}),
    ...(req.excludeDomains?.length ? { exclude_domains: [...req.excludeDomains] } : {}),
    extraction: { extraction_mode: "highlights" },
  };
}

/**
 * The passages of one search result, at most `HIGHLIGHTS_MAX_CHARS` characters in total. You.com
 * returns up to about 14,000 characters of passages for one result (seen on 2026-11-19). Exa is
 * asked for at most 1,500, and the pipeline is tuned for that size.
 */
export const HIGHLIGHTS_MAX_CHARS = 1500;
export function capHighlights(highlights: string[], maxChars: number = HIGHLIGHTS_MAX_CHARS): string[] {
  const out: string[] = [];
  let left = maxChars;
  for (const h of highlights) {
    if (left <= 0) break;
    out.push(h.length > left ? h.slice(0, left) : h);
    left -= h.length;
  }
  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

/**
 * The web results of a You.com reply as Exa results. The passages are in `contents.highlights`
 * (older replies: `snippets`); the description is the passage when there is none.
 */
export function youResults(body: unknown): ExaResult[] {
  const web = (body as { results?: { web?: unknown } } | null)?.results?.web;
  if (!Array.isArray(web)) return [];
  const out: ExaResult[] = [];
  for (const raw of web) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) continue;
    const contents = (r.contents && typeof r.contents === "object" ? r.contents : {}) as Record<string, unknown>;
    let highlights = capHighlights([...strings(contents.highlights), ...strings(r.snippets)]);
    if (!highlights.length && typeof r.description === "string" && r.description.trim()) highlights = [r.description.trim()];
    out.push({
      url: r.url,
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      ...(typeof r.page_age === "string" && r.page_age ? { publishedDate: r.page_age } : {}),
      ...(typeof r.thumbnail_url === "string" && r.thumbnail_url ? { image: r.thumbnail_url } : {}),
      ...(typeof r.favicon_url === "string" && r.favicon_url ? { favicon: r.favicon_url } : {}),
      ...(highlights.length ? { highlights } : {}),
    });
  }
  return out;
}

/**
 * A client with the interface of the Exa client: `search` calls You.com through the content
 * router, and `contents` calls `exa` (no full text without an Exa key). One retry after a rate limit.
 */
export function makeYouClient(router: RouterClient, exa: ExaClient | null, now: () => Date = () => new Date()): ExaClient {
  return {
    async search(req, deadline) {
      for (let attempt = 0; ; attempt += 1) {
        const callDeadline = Math.min(deadline, Date.now() + CALL_TIMEOUT_MS);
        try {
          const reply = await router.call({ endpoint: YOU_SEARCH_ENDPOINT, params: youSearchParams(req, now()) }, callDeadline);
          return youResults(reply.body);
        } catch (err) {
          if (attempt === 0 && err instanceof RouterError && err.kind === "rate limited" && deadline - Date.now() > 2000) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          throw err;
        }
      }
    },
    async contents(urls, deadline, opts) {
      return exa ? exa.contents(urls, deadline, opts) : [];
    },
  };
}

/** The You.com client of this box, or the reason why the box cannot call the content router. */
export function youClient(
  projectRoot: string,
  exa: ExaClient | null,
): { client: ExaClient } | { client: null; reason: RouterUnavailable } {
  const router = boxRouterClient(projectRoot);
  if (!router.client) return { client: null, reason: router.reason };
  return { client: makeYouClient(router.client, exa) };
}

export class YouError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One You.com call: the path of the API and the JSON body. Throws `YouError` when the call fails. */
export type YouPost = (path: "/v1/search" | "/v1/extract", body: unknown, deadline: number) => Promise<unknown>;

/** How long to wait after a rate limit, from the seconds that You.com gave. At most 5 seconds. */
function retryWaitMs(seconds: unknown): number {
  return Math.min(Number(seconds ?? 1) * 1000 || 1000, 5000);
}

/** You.com with a key of the box itself (a self-hosted box). One retry after a rate limit. */
export function youDirectPost(apiKey: string, fetchImpl: typeof fetch = fetch): YouPost {
  return async (path, body, deadline) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
      if (remaining <= 0) throw new YouError(0, "out of time");
      const res = await fetchImpl(`${YOU_BASE}${path}`, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
      });
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, retryWaitMs(res.headers.get("retry-after"))));
        continue;
      }
      if (!res.ok) throw new YouError(res.status, `You.com ${path} answered ${res.status}`);
      return res.json();
    }
    throw new YouError(429, `You.com ${path} rate limit`);
  };
}

/**
 * You.com through the proxy of the control plane (relay mode). The box sends its instance agent
 * token, and the control plane adds the You.com key. The proxy answers HTTP 200 with the status
 * of You.com in `status`. One retry after a rate limit of You.com.
 */
export function youRelayPost(relayUrl: string, bearer: () => string, fetchImpl: typeof fetch = fetch): YouPost {
  return async (path, body, deadline) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
      if (remaining <= 0) throw new YouError(0, "out of time");
      const res = await fetchImpl(relayUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path, json: body }),
        signal: AbortSignal.timeout(remaining),
      });
      if (!res.ok) throw new YouError(res.status, `the You.com proxy answered ${res.status}`);
      const reply = (await res.json()) as { status?: number; json?: unknown; retryAfter?: number };
      const status = typeof reply.status === "number" ? reply.status : 502;
      if (status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, retryWaitMs(reply.retryAfter)));
        continue;
      }
      if (status < 200 || status >= 300) throw new YouError(status, `You.com ${path} answered ${status}`);
      return reply.json;
    }
    throw new YouError(429, `You.com ${path} rate limit`);
  };
}

/**
 * How this box reaches You.com, or null when it cannot (change you-web-provider, design D1):
 * the proxy of the control plane in relay mode, or the own key of a self-hosted box.
 * `JOSHU_YOU_MODE=off` turns You.com off also when a key is set.
 */
export function youAccess(fetchImpl: typeof fetch = fetch): { post: YouPost; via: "relay" | "key" } | null {
  const mode = (provisionEnvTrim("JOSHU_YOU_MODE") || "").toLowerCase();
  if (mode === "off") return null;
  if (mode === "relay") {
    const cp = provisionEnvTrim("CONTROL_PLANE_URL")?.replace(/\/+$/, "");
    const relayUrl = provisionEnvTrim("JOSHU_YOU_RELAY_URL") || (cp ? `${cp}/api/instances/you/proxy` : "");
    if (!relayUrl) return null;
    try {
      instanceAgentBearerToken();
    } catch {
      return null;
    }
    return { post: youRelayPost(relayUrl, () => instanceAgentBearerToken(), fetchImpl), via: "relay" };
  }
  const key = provisionEnvTrim("YDC_API_KEY") || "";
  return key ? { post: youDirectPost(key, fetchImpl), via: "key" } : null;
}

/** The pictures of a page in its Markdown text (`![alt](url)`), at most `PAGE_PICTURES_MAX`. */
export function markdownPictures(markdown: string): { url: string; alt: string }[] {
  const out: { url: string; alt: string }[] = [];
  for (const m of markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)/g)) {
    if (out.length >= PAGE_PICTURES_MAX) break;
    if (!out.some((p) => p.url === m[2])) out.push({ url: m[2]!, alt: m[1]!.trim() });
  }
  return out;
}

/** The body of `POST /v1/extract` for one page: the text as Markdown. */
export function youExtractBody(url: string): Record<string, unknown> {
  return { url, full_page: { extraction_formats: ["markdown"] } };
}

/** One page of a `POST /v1/extract` reply as an Exa result, or null when You.com extracted no text. */
export function youPage(url: string, body: unknown, maxCharacters: number = PAGE_TEXT_MAX_CHARS): ExaResult | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fullPage = (b.contents as { full_page?: { markdown?: unknown } } | undefined)?.full_page;
  const markdown = typeof fullPage?.markdown === "string" ? fullPage.markdown : "";
  if (!markdown.trim()) return null;
  const pictures = markdownPictures(markdown);
  return {
    // The requested URL, because the callers match a page by the URL that they asked for.
    url,
    ...(typeof b.title === "string" && b.title ? { title: b.title } : {}),
    text: markdown.slice(0, maxCharacters),
    ...(pictures.length ? { extras: { richImageLinks: pictures } } : {}),
  };
}

/**
 * A client that calls You.com through `post` (the proxy of the control plane, or the own key of
 * the box). `exa` is the fallback: it answers a search or a page that You.com could not answer,
 * and it reads the passages of a page for a question (`highlightsQuery`), which You.com cannot do.
 */
export function makeYouApiClient(post: YouPost, exa: ExaClient | null, now: () => Date = () => new Date()): ExaClient {
  return {
    async search(req, deadline) {
      try {
        const youDeadline = exa ? Math.min(deadline, Date.now() + YOU_SEARCH_FIRST_TRY_MS) : deadline;
        return youResults(await post("/v1/search", youSearchParams(req, now()), youDeadline));
      } catch (err) {
        if (!exa) throw err;
        return exa.search(req, deadline);
      }
    },
    async contents(urls, deadline, opts = {}) {
      if (!urls.length) return [];
      if (opts.highlightsQuery) return exa ? exa.contents(urls, deadline, opts) : [];
      // One call for each page. Stop a little before the deadline of the caller, so that the
      // pages that were read in time are returned and not lost with the late ones.
      const pagesDeadline = Math.min(deadline - DEADLINE_MARGIN_MS, exa ? Date.now() + YOU_PAGES_FIRST_TRY_MS : Infinity);
      const pages = await mapLimit(urls, YOU_EXTRACT_CONCURRENCY, async (url) => {
        try {
          return youPage(url, await post("/v1/extract", youExtractBody(url), pagesDeadline), opts.maxCharacters);
        } catch {
          return null;
        }
      });
      const found = pages.filter((p): p is ExaResult => p !== null);
      const missed = urls.filter((_, i) => pages[i] === null);
      if (!missed.length || !exa || deadline - Date.now() < EXA_PAGES_MIN_MS) return found;
      try {
        return [...found, ...(await exa.contents(missed, deadline, opts))];
      } catch {
        return found;
      }
    },
  };
}

/** What `boxWebClient` can take from a test in place of the keys of the box. */
export type WebClientDeps = {
  /** The Exa client (null: the box has no Exa key). Default: the Exa key of the box. */
  exa?: ExaClient | null;
  /** The You.com client (null: the box cannot call You.com). Default: the You.com access of the box (`youAccess`). */
  you?: ExaClient | null;
};

/**
 * The web client of this box for a Research report or a recurring report (change
 * you-web-provider). With no `want`, the box uses You.com when it can reach You.com (`youAccess`), and Exa
 * when it only has an Exa key. `want` names the provider that the owner asked for in the request.
 */
export function boxWebClient(
  projectRoot: string,
  want?: WebProvider,
  deps: WebClientDeps = {},
): { client: ExaClient; provider: WebProvider } | { client: null; reason: string } {
  const exa = deps.exa === undefined ? exaClient(projectRoot) : deps.exa;
  if (want === "exa") {
    return exa ? { client: exa, provider: "exa" } : { client: null, reason: "the box has no Exa key for web search" };
  }
  const access = deps.you === undefined ? youAccess() : null;
  const direct = deps.you === undefined ? (access ? makeYouApiClient(access.post, exa) : null) : deps.you;
  if (direct) return { client: direct, provider: "you.com" };
  if (want === "you.com") {
    // No You.com access: the content router can still run the You.com search (change research-web-provider).
    const router = deps.you === undefined ? youClient(projectRoot, exa) : { client: null, reason: "content router off" as const };
    if (router.client) return { client: router.client, provider: "you.com" };
    return { client: null, reason: `You.com web search needs You.com access or the content router, and this box has neither (${router.reason})` };
  }
  if (exa) return { client: exa, provider: "exa" };
  return { client: null, reason: "the box has no You.com access and no Exa key for web search" };
}
