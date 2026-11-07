/**
 * The You.com client of the research pipeline (change research-web-provider): the web search of a
 * Research report through the content router, endpoint `you.web.search.highlights`, when the
 * owner or the companion chose You.com for the report. It has the interface of the Exa client, so
 * `searchWeb` uses it in place of the Exa client. The router has no You.com endpoint for the full
 * text of a page, so `contents` stays on Exa. `searchAll` runs at most four searches at once, as
 * with Exa, and each search has the time limit of one Exa call.
 */

import { boxRouterClient, RouterError, type RouterClient, type RouterUnavailable } from "../../contentRouter/client.js";
import type { ExaClient, ExaResult, ExaSearchRequest } from "./exa.js";

export const YOU_SEARCH_ENDPOINT = "you.web.search.highlights";
const CALL_TIMEOUT_MS = 30_000;

/** The web search provider of a Research report. Default: Exa. */
export type WebProvider = "exa" | "you.com";
export const WEB_PROVIDERS: readonly WebProvider[] = ["exa", "you.com"];

/** The provider for a value from a request, or null when the value is not a known provider. Empty means Exa. */
export function parseWebProvider(value: unknown): WebProvider | null {
  if (value === undefined || value === null || value === "") return "exa";
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
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
    let highlights = [...strings(contents.highlights), ...strings(r.snippets)];
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
