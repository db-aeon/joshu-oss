/**
 * The source search client of the research pipeline (glossary: Source search): news, research
 * papers, the SEC filings of a company, and the daily stock prices of a company, through the
 * content router. Change research-router-sources, design decisions D1 to D4.
 *
 * News, research papers, and SEC filings are content goals (change content-router): the code names
 * what the report needs, and the box finds a provider endpoint in the router catalog, learns how
 * to read its reply, and keeps both in its caches. No provider name is in this file for them.
 *
 * Stock prices are not a content goal. A goal returns items with a title and a link, and the
 * report needs one number for each trading day. So the prices have one fixed provider endpoint.
 */

import { boxRouterClient, RouterError, USAGE_WALLET_EMPTY, type RouterClient } from "../../contentRouter/client.js";
import { resolveGoal, usableRoute, type ContentGoal, type GoalResult, type GoalSearch } from "../../contentRouter/goals.js";
import { goalKey, readRoutes } from "../../contentRouter/store.js";
import type { ExaResult } from "./exa.js";
import { limiter } from "./llm.js";

/** The goals of the three sources that the box finds by itself: what the report needs, in plain words. */
export const NEWS_GOAL = { id: "news", kind: "News articles", label: "News" } as const;
export const PAPERS_GOAL = { id: "scholar", kind: "Research papers", label: "Research papers" } as const;
export const FILINGS_GOAL = { id: "filings", kind: "SEC filings", label: "SEC filings" } as const;

/** The provider endpoints of the stock prices, the one source with fixed code. */
export const PRICES_ENDPOINT = "tiingo.daily.prices";
export const COMPANY_NAME_ENDPOINT = "tiingo.daily.meta";
/** The exchanges of the price source, as Google Finance writes them in `<ticker>:<exchange>`. */
export const PRICE_EXCHANGES: ReadonlySet<string> = new Set(["NASDAQ", "NYSE", "NYSEARCA", "NYSEAMERICAN", "BATS"]);

export const SOURCE_SEARCH_CONCURRENCY = 4;
const CALL_TIMEOUT_MS = 40_000;
const MAX_FILINGS = 3;
const PRICE_DAYS = 31;
/** The age of the oldest filing that a report reads, in days. */
const FILING_DAYS = 365;
/** The forms that a report reads, in the title of a filing, for example `8-K`, `Form 10-Q`, or `10-K/A`. */
const FILING_FORM = /(?:^|[^0-9A-Za-z-])(10-K|10-Q|8-K)(?![0-9A-Za-z-])/i;
/** A title that is a form code and not a description, for example `4`, `144`, or `SC 13G`. */
const FORM_CODE = /^(?=.*\d|[A-Z0-9 /-]+$)[0-9A-Za-z /-]{1,12}$/;
/**
 * Reasons of a failed goal that hold for every query of the goal kind in one report. The other
 * calls of the kind then fail with the same reason and make no call.
 */
const KIND_FAULTS: ReadonlySet<string> = new Set([USAGE_WALLET_EMPTY, "unauthorized", "no route", "could not be read", "no channel available", "content router off"]);
const NEWS_DAYS = { d: 1, w: 7, m: 31, y: 365 } as const;
/** Research papers have no period: a paper of any year counts. */
const ANY_DAY = "1900-01-01";
/** The end of a trading day in the local time of the exchange. The price source has only closes. */
const CLOSE_TIME = "4:00 PM";

/** One price of the stock. Each point of the price source is the close of a trading day, so `close` is true. */
export type PricePoint = { day: string; time: string; price: number; volume?: number; close: boolean };
export type StockPrices = { name: string; symbol: string; currency: string; points: PricePoint[] };
export type Filing = { form: string; filedAt: string; reportDate?: string; url: string };
export type CompanyFilings = { companyName: string; filings: Filing[] };

export type SourceSearchClient = {
  /** `when` is the period of the news: `d`, `w`, `m` (the default), or `y`. */
  news(query: string, deadline: number, when?: "d" | "w" | "m" | "y"): Promise<ExaResult[]>;
  scholar(query: string, deadline: number): Promise<ExaResult[]>;
  /** `symbol` is `<ticker>:<exchange>`, for example `NVDA:NASDAQ`. Null when the answer has no prices. */
  prices(symbol: string, deadline: number): Promise<StockPrices | null>;
  filings(ticker: string, deadline: number): Promise<CompanyFilings>;
};

/** Resolves one content goal. The box version is `resolveGoal` with the router client of the box. */
export type GoalResolver = (goal: ContentGoal, search: GoalSearch) => Promise<GoalResult>;

/** True when the route cache of the box has a route for the goal kind. */
export type RouteKnown = (kind: string) => boolean;

function boxRouteKnown(kind: string): boolean {
  try {
    return Boolean(usableRoute(readRoutes().routes[goalKey(kind)]));
  } catch {
    return false;
  }
}

/** The source search client of this box. Returns null when the box cannot call the content router. */
export function sourceSearchClient(projectRoot: string, fetchImpl: typeof fetch = fetch): SourceSearchClient | null {
  const box = boxRouterClient(projectRoot, fetchImpl);
  if (!box.client) return null;
  const client = box.client;
  return makeSourceSearchClient(client, (goal, search) => resolveGoal(goal, search, { client, llm: { projectRoot } }), { routeKnown: boxRouteKnown });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object") : [];
}

function dayBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The daily closes of the price source, oldest first. Null when the answer has no price. A stock
 * split inside the period changes the price by the split factor on one day. So each close before a
 * split is divided by the split factor, and the closes of the period can be compared.
 */
export function stockPrices(body: unknown, symbol: string, name: string): StockPrices | null {
  const days = asRecords(body)
    .flatMap((p) => {
      const day = asText(p.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof p.close !== "number") return [];
      const split = typeof p.splitFactor === "number" && p.splitFactor > 0 ? p.splitFactor : 1;
      return [{ day, close: p.close, volume: typeof p.volume === "number" ? p.volume : undefined, split }];
    })
    .sort((a, b) => b.day.localeCompare(a.day));
  // Newest first: the split factor of a day applies to each day before it.
  let factor = 1;
  const points: PricePoint[] = [];
  for (const d of days) {
    points.unshift({ day: d.day, time: CLOSE_TIME, price: Math.round((d.close / factor) * 10_000) / 10_000, volume: d.volume, close: true });
    factor *= d.split;
  }
  if (!points.length) return null;
  // The price source lists stocks of exchanges in the United States, with prices in US dollars.
  return { name, symbol, currency: "USD", points };
}

/**
 * The filings of a company from the items of the goal: the form type is the title of an item and
 * the filing date is its date. The report reads forms 10-K, 10-Q, and 8-K. When no title is one of
 * these forms, the provider endpoint that the box found names its items in another way, and the
 * newest items count.
 */
export function filingsOf(result: GoalResult, companyName: string): CompanyFilings {
  const all = result.items
    .filter((i) => i.url && i.publishedAt)
    .map((i) => ({ form: i.title.trim(), filedAt: i.publishedAt!, url: i.url }))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  const forms = all.flatMap((f) => {
    const m = f.form.match(FILING_FORM);
    return m ? [{ ...f, form: m[1]!.toUpperCase() }] : [];
  });
  // Titles that are form codes, with none of the three forms: the company filed only other forms.
  const otherForms = !forms.length && all.some((f) => FORM_CODE.test(f.form));
  return { companyName, filings: (forms.length ? forms : otherForms ? [] : all).slice(0, MAX_FILINGS) };
}

export function makeSourceSearchClient(
  router: RouterClient,
  resolve: GoalResolver,
  opts: { now?: () => Date; routeKnown?: RouteKnown } = {},
): SourceSearchClient {
  const now = opts.now ?? (() => new Date());
  const routeKnown = opts.routeKnown ?? (() => false);
  const limit = limiter(SOURCE_SEARCH_CONCURRENCY);
  const names = new Map<string, Promise<string>>();
  /** For each goal kind: whether the route cache has a route, the call that is finding one, and a reason that fails the kind. */
  const gates = new Map<string, { warm: boolean; lead?: Promise<void>; failed?: string }>();

  /**
   * One content goal. A report asks for the news of each sub-question at the same time. With no
   * route in the route cache, each of these calls would find a provider endpoint by itself, with a
   * model call each. So while a goal kind has no route, one call at a time runs, and the others
   * wait for it. When a call left a route, the others run at the same time. When a call fails for
   * a reason that holds for the whole goal kind, the others fail with that reason and make no call.
   */
  async function goal(kind: { id: string; kind: string; label: string }, query: string, sinceDay: string, deadline: number): Promise<GoalResult> {
    let gate = gates.get(kind.kind);
    if (!gate) {
      gate = { warm: routeKnown(kind.kind) };
      gates.set(kind.kind, gate);
    }
    const finish = (result: GoalResult): GoalResult => {
      // A goal never throws. The callers of the source search expect a failed call to throw its
      // reason, and the source list links to the usage billing page for "usage wallet empty".
      if (result.state.state === "could not be reached") throw new Error(result.state.engineStatus || "could not be reached");
      return result;
    };
    for (;;) {
      if (deadline - Date.now() <= 0) throw new Error(`${kind.label}: out of time`);
      if (gate.failed) throw new Error(gate.failed);
      const run = () => resolve({ ...kind, query }, { sinceDay, deadline });
      if (gate.warm) return finish(await run());
      if (!gate.lead) {
        const mine = run();
        gate.lead = mine.then(
          () => undefined,
          () => undefined,
        );
        let result: GoalResult;
        try {
          result = await mine;
        } finally {
          gate.lead = undefined;
        }
        const reason = result.state.state === "could not be reached" ? result.state.engineStatus : "";
        if (reason && KIND_FAULTS.has(reason)) gate.failed = reason;
        else if (!reason && (result.items.length > 0 || routeKnown(kind.kind))) gate.warm = true;
        return finish(result);
      }
      await gate.lead;
    }
  }

  function hits(result: GoalResult): ExaResult[] {
    return result.items.filter((i) => i.url).map((i) => ({ url: i.url, title: i.title, publishedDate: i.publishedAt, highlights: i.summary ? [i.summary] : [] }));
  }

  function priceCall(endpoint: string, params: Record<string, unknown>, deadline: number): Promise<unknown> {
    return limit(async () => {
      if (deadline - Date.now() <= 0) throw new Error(`${endpoint}: out of time`);
      try {
        return (await router.call({ endpoint, params }, deadline, { timeoutMs: CALL_TIMEOUT_MS })).body;
      } catch (err) {
        if (err instanceof RouterError && err.kind === USAGE_WALLET_EMPTY) throw new RouterError(USAGE_WALLET_EMPTY, USAGE_WALLET_EMPTY);
        throw err;
      }
    });
  }

  /**
   * The name of the company of a ticker, or "" when the lookup fails. The report compares the name
   * with the company of the plan, so that a wrong ticker gives no company page. One lookup serves
   * the prices and the filings of one report.
   */
  function companyName(ticker: string, deadline: number): Promise<string> {
    const key = ticker.toUpperCase();
    let found = names.get(key);
    if (!found) {
      found = priceCall(COMPANY_NAME_ENDPOINT, { ticker: key }, deadline).then(
        (body) => asText((body as { name?: unknown } | null)?.name),
        () => "",
      );
      names.set(key, found);
    }
    return found;
  }

  return {
    async news(query, deadline, when = "m") {
      return hits(await goal(NEWS_GOAL, query, dayBefore(now(), NEWS_DAYS[when]), deadline));
    },
    async scholar(query, deadline) {
      return hits(await goal(PAPERS_GOAL, query, ANY_DAY, deadline));
    },
    async prices(symbol, deadline) {
      const [rawTicker, rawExchange = ""] = symbol.split(":");
      const ticker = rawTicker!.toUpperCase();
      const exchange = rawExchange.toUpperCase();
      // The same ticker on another exchange is another listing, with other prices and another currency.
      if (exchange && !PRICE_EXCHANGES.has(exchange)) throw new Error(`no stock prices for exchange ${exchange}`);
      const today = now();
      const [body, name] = await Promise.all([
        priceCall(PRICES_ENDPOINT, { ticker, startDate: dayBefore(today, PRICE_DAYS), endDate: dayBefore(today, 0) }, deadline),
        companyName(ticker, deadline),
      ]);
      return stockPrices(body, symbol, name);
    },
    async filings(ticker, deadline) {
      const [result, name] = await Promise.all([
        goal(FILINGS_GOAL, ticker.toUpperCase(), dayBefore(now(), FILING_DAYS), deadline),
        companyName(ticker, deadline),
      ]);
      return filingsOf(result, name);
    },
  };
}
