/**
 * The Composio Search client of the research pipeline (glossary: Composio Search): Google News,
 * Google Scholar, stock prices, and SEC filings through the Composio tools API, with the Composio
 * key of the box and the pinned toolkit version. Each call has 40 seconds and no retry, and one box
 * runs at most four Composio calls at once. Change research-report-sources, design decisions D1 and D6.
 */

import { resolveComposioUserId } from "../../composioApi.js";
import {
  COMPOSIO_SEARCH_FINANCE,
  COMPOSIO_SEARCH_NEWS,
  COMPOSIO_SEARCH_SCHOLAR,
  COMPOSIO_SEARCH_SEC_FILINGS,
  COMPOSIO_SEARCH_TOOLKIT_VERSION,
} from "../../connectors/composio/composioSearchConfig.js";
import type { ExaResult } from "./exa.js";
import { limiter } from "./llm.js";

const EXECUTE_BASE = "https://backend.composio.dev/api/v3.1/tools/execute";
export const COMPOSIO_CONCURRENCY = 4;
const CALL_TIMEOUT_MS = 40_000;
const MAX_FILINGS = 3;

/** One price of the stock. `close` is false for the latest price of a trading day that is not over. */
export type PricePoint = { day: string; time: string; price: number; volume?: number; close: boolean };
export type StockPrices = { name: string; symbol: string; currency: string; points: PricePoint[] };
export type Filing = { form: string; filedAt: string; reportDate?: string; url: string };
export type CompanyFilings = { companyName: string; filings: Filing[] };

export type ComposioSearchClient = {
  /** `when` is the period of Google News: `d`, `w`, `m` (the default), or `y`. */
  news(query: string, deadline: number, when?: "d" | "w" | "m" | "y"): Promise<ExaResult[]>;
  scholar(query: string, deadline: number): Promise<ExaResult[]>;
  /** `symbol` is `<ticker>:<exchange>`, for example `NVDA:NASDAQ`. Null when the answer has no prices. */
  prices(symbol: string, deadline: number): Promise<StockPrices | null>;
  filings(ticker: string, deadline: number): Promise<CompanyFilings>;
};

export class ComposioSearchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Composio Search client with the key of the box. Returns null when the box has no Composio key. */
export function composioSearchClient(projectRoot: string, fetchImpl: typeof fetch = fetch): ComposioSearchClient | null {
  const key = process.env.COMPOSIO_API_KEY?.trim();
  if (!key) return null;
  return makeComposioSearchClient(key, resolveComposioUserId(projectRoot), fetchImpl);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object") : [];
}

/** `2026-09-30 07:00:00 UTC` to an ISO time, or undefined. */
function newsDate(value: unknown): string | undefined {
  const m = asText(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}.000Z` : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Sep 21 2026, 04:00 PM UTC-04:00` to the day and the local time of the exchange. */
function priceDate(value: unknown): { day: string; time: string } | null {
  const m = asText(value).match(/^([A-Z][a-z]{2}) (\d{1,2}) (\d{4}), (\d{1,2}:\d{2} [AP]M)/);
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month < 0) return null;
  return { day: `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`, time: m[4]! };
}

export function newsHits(data: unknown): ExaResult[] {
  const results = asRecords((data as { news_results?: unknown } | null)?.news_results);
  return results.flatMap((r) => {
    const url = asText(r.link);
    if (!url) return [];
    const snippet = asText(r.snippet);
    return [{ url, title: asText(r.title), publishedDate: newsDate(r.published_at), highlights: snippet ? [snippet] : [] }];
  });
}

export function scholarHits(data: unknown): ExaResult[] {
  const articles = asRecords((data as { articles?: unknown } | null)?.articles);
  return articles.flatMap((a) => {
    const url = asText(a.link);
    if (!url) return [];
    const authors = asRecords(a.authors).map((x) => asText(x.name)).filter(Boolean);
    const about = [
      authors.length ? `Authors: ${authors.join(", ")}.` : "",
      asText(a.publication_year) ? `Year: ${asText(a.publication_year)}.` : "",
      typeof a.citation_count === "number" ? `Cited by ${a.citation_count}.` : "",
    ].filter(Boolean);
    const highlights = [asText(a.snippet), about.join(" ")].filter(Boolean);
    return [{ url, title: asText(a.title), highlights }];
  });
}

export function stockPrices(data: unknown, symbol: string): StockPrices | null {
  const results = (data as { results?: { currency?: unknown; graph?: unknown; summary?: Record<string, unknown> } } | null)?.results;
  const points: PricePoint[] = asRecords(results?.graph).flatMap((g) => {
    const when = priceDate(g.date);
    if (!when || typeof g.price !== "number") return [];
    return [{ ...when, price: g.price, volume: typeof g.volume === "number" ? g.volume : undefined, close: when.time === "4:00 PM" || when.time === "04:00 PM" }];
  });
  if (!points.length) return null;
  return {
    name: asText(results?.summary?.title),
    symbol,
    currency: asText(results?.currency) || asText(results?.summary?.currency),
    points,
  };
}

export function companyFilings(data: unknown): CompanyFilings {
  const d = (data ?? {}) as { company_name?: unknown; filings?: unknown };
  const filings = asRecords(d.filings)
    .flatMap((f) => {
      const url = asText(f.primary_document_url);
      if (!url) return [];
      return [{ form: asText(f.form_type), filedAt: asText(f.filing_date), reportDate: asText(f.report_date) || undefined, url }];
    })
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
    .slice(0, MAX_FILINGS);
  return { companyName: asText(d.company_name), filings };
}

export function makeComposioSearchClient(apiKey: string, userId: string, fetchImpl: typeof fetch = fetch): ComposioSearchClient {
  const limit = limiter(COMPOSIO_CONCURRENCY);

  function execute(slug: string, args: Record<string, unknown>, deadline: number): Promise<unknown> {
    return limit(async () => {
      const remaining = Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
      if (remaining <= 0) throw new ComposioSearchError(0, "out of time");
      const res = await fetchImpl(`${EXECUTE_BASE}/${slug}`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, version: COMPOSIO_SEARCH_TOOLKIT_VERSION, arguments: args }),
        signal: AbortSignal.timeout(remaining),
      });
      if (!res.ok) throw new ComposioSearchError(res.status, `Composio ${slug} answered ${res.status}`);
      const body = (await res.json()) as { successful?: boolean; error?: unknown; data?: unknown };
      if (body.successful === false) throw new ComposioSearchError(res.status, `Composio ${slug} failed: ${asText(body.error) || "no reason"}`);
      return body.data;
    });
  }

  return {
    async news(query, deadline, when = "m") {
      return newsHits(await execute(COMPOSIO_SEARCH_NEWS, { query, when, hl: "en" }, deadline));
    },
    async scholar(query, deadline) {
      return scholarHits(await execute(COMPOSIO_SEARCH_SCHOLAR, { query }, deadline));
    },
    async prices(symbol, deadline) {
      return stockPrices(await execute(COMPOSIO_SEARCH_FINANCE, { query: symbol, window: "1M" }, deadline), symbol);
    },
    async filings(ticker, deadline) {
      const args = { ticker_or_cik: ticker, form_types: ["10-K", "10-Q", "8-K"], limit: MAX_FILINGS, include_document_links: true };
      return companyFilings(await execute(COMPOSIO_SEARCH_SEC_FILINGS, args, deadline));
    },
  };
}
