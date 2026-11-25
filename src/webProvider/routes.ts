/**
 * The web routes of the Joshu API for the Hermes plugin `joshu-web-you` (change
 * you-web-provider): `POST /api/web/search` and `POST /api/web/extract`.
 *
 * The companion calls `web_search` and `web_extract`. The plugin posts those calls here, and the
 * Joshu API runs them with the web client of the box (`boxWebClient`): You.com through the proxy
 * of the control plane, or the own key of a self-hosted box, with Exa as the fallback. So the
 * plugin and Hermes hold no key and no rule about the provider.
 */

import type { Request, Response, Router } from "express";
import { verifyArozosDesktopSession } from "../httpLocalhost.js";
import type { ExaClient } from "../research/pipeline/exa.js";
import { boxWebClient, type WebProvider } from "../research/pipeline/you.js";

const SEARCH_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;
/** The description of one search result for the companion. The passages of a result can be long. */
const DESCRIPTION_MAX_CHARS = 600;
/** One web_extract call of Hermes reads at most a few pages. */
const MAX_URLS = 10;
/** The companion can read a longer text than the research pipeline takes from one page. */
const PAGE_TEXT_MAX_CHARS = 60_000;

type WebClientOfBox = { client: ExaClient; provider: WebProvider } | { client: null; reason: string };

export type WebProviderRouteDeps = {
  projectRoot: string;
  /** Tests pass a fake. Default: the web client of the box. */
  webClient?: () => WebClientOfBox;
  allowRequest?: (req: Request) => boolean | Promise<boolean>;
};

function httpUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim())).map((u) => u.trim());
}

/** The two routes: the desktop session of the owner or direct localhost (the Hermes plugin). */
export function registerWebProviderRoutes(router: Router, deps: WebProviderRouteDeps): void {
  const allowed = deps.allowRequest ?? verifyArozosDesktopSession;
  const webClient = deps.webClient ?? (() => boxWebClient(deps.projectRoot));

  router.post("/api/web/search", async (req: Request, res: Response) => {
    if (!(await allowed(req))) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      res.status(400).json({ ok: false, error: "query is required" });
      return;
    }
    const limit = Math.max(1, Math.min(Number(req.body?.limit) || DEFAULT_RESULTS, MAX_RESULTS));
    const web = webClient();
    if (!web.client) {
      res.status(503).json({ ok: false, error: web.reason });
      return;
    }
    try {
      const results = await web.client.search({ query, numResults: limit }, Date.now() + SEARCH_TIMEOUT_MS);
      res.json({
        ok: true,
        provider: web.provider,
        web: results.slice(0, limit).map((r, i) => ({
          url: r.url,
          title: r.title ?? "",
          description: (r.highlights ?? []).join(" ").slice(0, DESCRIPTION_MAX_CHARS),
          position: i + 1,
        })),
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: `web search failed: ${(err as Error).message}` });
    }
  });

  router.post("/api/web/extract", async (req: Request, res: Response) => {
    if (!(await allowed(req))) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const urls = httpUrls(req.body?.urls);
    if (!urls.length || urls.length > MAX_URLS) {
      res.status(400).json({ ok: false, error: `urls must have 1 to ${MAX_URLS} http or https URLs` });
      return;
    }
    const web = webClient();
    if (!web.client) {
      res.status(503).json({ ok: false, error: web.reason });
      return;
    }
    try {
      const pages = await web.client.contents(urls, Date.now() + EXTRACT_TIMEOUT_MS, { maxCharacters: PAGE_TEXT_MAX_CHARS });
      res.json({
        ok: true,
        provider: web.provider,
        // A page that no provider could read is left out. The plugin reports it as an error for that URL.
        pages: pages.filter((p) => p.text?.trim()).map((p) => ({ url: p.url, title: p.title ?? "", content: p.text! })),
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: `web extract failed: ${(err as Error).message}` });
    }
  });
}
