/**
 * The collect step of a run (design decision D3): for each lane, the queries of its lane plan on
 * its sources, for the period of the run. The box reads no full pages and extracts no facts, because
 * the theme step reads the best pages of each theme later (change research-report-topics, D6). A
 * web or news page without a publication date is left out, because the box cannot tell whether it
 * is new, and an item of the content router without a date gets the day of the run (D4). Each lane
 * also searches its search terms by name on Exa and Google News, with a limit for each run (change
 * research-keyword-expansion). The lanes run in parallel, with at most four Exa
 * searches at once on the box. Web search is the one source that fails the run: when every Exa
 * search fails, the run has no pages to report from. Every other source only gets its state.
 */

import { ResearchStepError } from "../errors.js";
import type { ComposioSearchClient } from "../pipeline/composioSearch.js";
import { EXA_CONCURRENCY, type ExaClient, type ExaResult } from "../pipeline/exa.js";
import { limiter, withDeadline } from "../pipeline/llm.js";
import { EXCLUDED_DOMAINS, TERM_RESULTS } from "../pipeline/search.js";
import { preferredCounter } from "../engagement.js";
import { customGoalId } from "../../contentRouter/goals.js";
import { goalsOfSources, searchSocial, type GoalRequest, type SocialDeps } from "../social/sources.js";
import type { SourceState } from "../types.js";
import type { Lane, LanePlan, ResearchSourceId } from "./types.js";

/** One page or post that a run found, before the group step. */
export type RunItem = {
  /** `n1`, `n2`, ... inside one run; the group step names items by it. */
  key: string;
  laneId: string;
  url: string;
  source: string;
  sourceLabel: string;
  title: string;
  text: string;
  publishedAt?: string;
  engagement?: Record<string, number>;
};

export type CollectPeriod = { from: string; fromDay: string; to: string; days: number };

export type CollectDeps = {
  exa: ExaClient | null;
  composio: ComposioSearchClient | null;
  social?: SocialDeps;
  /** Tests pass a fake fetch for the redirects of Google News. */
  fetchImpl?: typeof fetch;
};

const REDIRECT = /^https?:\/\/(www\.)?google\.com\/(goto|url)\b/;
const redirectSlots = limiter(8);

/**
 * The article behind a Google News redirect link, from the `Location` of its 302 answer. The same
 * article then has the same link on every run, so the compare step can match it by link, and the
 * owner sees the site in the digest. Keeps the redirect link when the answer has no location.
 */
export async function resolveRedirect(url: string, deadline: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!REDIRECT.test(url)) return url;
  try {
    // A GET: from a box, Google answers a HEAD with 200 and no location (seen on a box, 2026-10-29).
    const res = await redirectSlots(() => fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))) }));
    const location = res.headers.get("location") ?? "";
    await res.body?.cancel().catch(() => undefined);
    return /^https?:\/\//.test(location) && !REDIRECT.test(location) ? location : url;
  } catch {
    return url;
  }
}

const WEB_RESULTS = 8;
/** The most search terms that one run searches: all named terms, then expanded terms up to this number. */
export const MAX_TERMS_PER_RUN = 16;
const POSTS_PER_SOURCE = 10;
/** A stock price move smaller than this over the period is not news. */
export const PRICE_MOVE_PERCENT = 5;

const exaSlots = limiter(EXA_CONCURRENCY);

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function newsWhen(days: number): "d" | "w" | "m" | "y" {
  return days <= 1 ? "d" : days <= 7 ? "w" : days <= 31 ? "m" : "y";
}

function state(name: string, label: string, ok: boolean, found: number, status = "ok"): SourceState {
  if (!ok) return { name, label, state: "could not be reached", engineStatus: status };
  return { name, label, state: found ? "returned items" : "returned no items", engineStatus: status };
}

type Draft = Omit<RunItem, "key" | "laneId">;

/**
 * True for a page that lists articles instead of being one: the home page of a site, or a category,
 * tag, or news index. A live run on 2026-10-29 linked stories to such pages, which change every day.
 */
export function isIndexPage(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return true;
  }
  if (!pathname) return true;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.some((p) => /^(category|categories|tag|tags|topic|topics|section|author|authors)$/i.test(p))) return true;
  // The last part names a list, for example `/news` or `/en/news` (a language prefix before it).
  const last = parts.at(-1)!;
  const listWord = /^([a-z]+-)?(news|blog|insights|articles|press|latest|updates)(-[a-z]+)?$/i.test(last);
  return listWord && (parts.length === 1 || (parts.length === 2 && /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]!)));
}

function pageItem(r: ExaResult, source: string, sourceLabel: string): Draft {
  const site = host(r.url);
  return {
    url: r.url,
    source,
    sourceLabel: source === "web" ? site || sourceLabel : sourceLabel,
    title: (r.title ?? "").trim() || site,
    text: (r.highlights ?? []).join(" ").replace(/\s+/g, " ").trim().slice(0, 600),
    ...(r.publishedDate ? { publishedAt: r.publishedDate.slice(0, 10) } : {}),
  };
}

async function attempt<T>(fn: () => Promise<T>, deadline: number): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await withDeadline(fn(), deadline) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * The search terms of each lane for one run, in the order of `plans`: every named term, and then
 * the expanded terms of the lanes in turn, one term of each lane at a time, until the run has
 * `MAX_TERMS_PER_RUN` terms.
 */
export function runTerms(plans: (LanePlan | undefined)[]): string[][] {
  const out = plans.map((p) => [...(p?.namedTerms ?? [])]);
  const queues = plans.map((p) => [...(p?.expandedTerms ?? [])]);
  let left = MAX_TERMS_PER_RUN - out.reduce((n, t) => n + t.length, 0);
  while (left > 0 && queues.some((q) => q.length)) {
    queues.forEach((q, i) => {
      if (left > 0 && q.length) {
        out[i]!.push(q.shift()!);
        left -= 1;
      }
    });
  }
  return out;
}

/** The queries of the lane plan, then each search term that is not one of them. */
function withTerms(queries: string[], terms: string[]): { query: string; term: boolean }[] {
  const seen = new Set(queries.map((q) => q.toLowerCase()));
  return [...queries.map((query) => ({ query, term: false })), ...terms.filter((t) => !seen.has(t.toLowerCase())).map((query) => ({ query, term: true }))];
}

/**
 * Collect the items of one lane, with the search terms that `runTerms` gave it. `webFailed` counts
 * the failed Exa searches.
 */
export async function collectLane(
  lane: Lane,
  sources: ResearchSourceId[],
  period: CollectPeriod,
  deadline: number,
  deps: CollectDeps,
  terms: string[] = [],
): Promise<{ items: Draft[]; sources: SourceState[]; webSearches: number; webFailed: number }> {
  const plan = lane.plan;
  const items: Draft[] = [];
  const states: SourceState[] = [];
  const jobs: Promise<void>[] = [];
  let webSearches = 0;
  let webFailed = 0;

  // Web pages from Exa, and Google News, both part of "Web and news".
  const webQueries = withTerms(plan?.webQueries.length ? plan.webQueries : [lane.topic], terms);
  if (deps.exa) {
    const exa = deps.exa;
    jobs.push(
      (async () => {
        const results = await Promise.all(
          webQueries.map(({ query, term }) =>
            attempt(
              () => exaSlots(() => exa.search({ query, numResults: term ? TERM_RESULTS : WEB_RESULTS, startPublishedDate: period.from, excludeDomains: EXCLUDED_DOMAINS }, deadline)),
              deadline,
            ),
          ),
        );
        webSearches = results.length;
        webFailed = results.filter((r) => r.error).length;
        // A page without a date cannot be shown to be new (spec `research-report-updates`).
        const pages = results.flatMap((r) => r.value ?? []).filter((p) => !isIndexPage(p.url) && p.publishedDate);
        items.push(...pages.map((p) => pageItem(p, "web", "Web")));
        states.push(state("web", "Web (Exa)", webFailed < webSearches, pages.length, webFailed ? `${webFailed} of ${webSearches} searches failed` : "ok"));
      })(),
    );
  } else {
    webSearches = webQueries.length;
    webFailed = webQueries.length;
    states.push(state("web", "Web (Exa)", false, 0, "no Exa key"));
  }

  const composio = deps.composio;
  if (composio) {
    jobs.push(
      (async () => {
        const searches = await Promise.all(
          withTerms([plan?.newsQuery || lane.topic], terms).map(({ query }) => attempt(() => composio.news(query, deadline, newsWhen(period.days)), deadline)),
        );
        const failed = searches.filter((n) => n.error);
        const dated = searches.flatMap((n) => n.value ?? []).filter((h) => h.publishedDate && h.publishedDate.slice(0, 10) >= period.fromDay);
        const hits = await Promise.all(dated.map(async (h) => ({ ...h, url: await resolveRedirect(h.url, deadline, deps.fetchImpl) })));
        const status = !failed.length ? "ok" : searches.length === 1 ? failed[0]!.error! : `${failed.length} of ${searches.length} searches failed`;
        items.push(...hits.map((h) => pageItem(h, "news", host(h.url) || "Google News")));
        states.push(state("news", "Google News", failed.length < searches.length, hits.length, status));
      })(),
    );
  } else {
    states.push(state("news", "Google News", false, 0, "no Composio key"));
  }

  if (sources.includes("papers")) {
    jobs.push(
      (async () => {
        if (!composio) return void states.push(state("scholar", "Google Scholar", false, 0, "no Composio key"));
        const papers = await attempt(() => composio.scholar(plan?.scholarQuery || lane.topic, deadline), deadline);
        const hits = (papers.value ?? []).slice(0, WEB_RESULTS);
        items.push(...hits.map((h) => pageItem(h, "papers", "Google Scholar")));
        states.push(state("scholar", "Google Scholar", !papers.error, hits.length, papers.error ?? "ok"));
      })(),
    );
  }

  if (sources.includes("company") && plan?.company) {
    const company = plan.company;
    jobs.push(
      (async () => {
        if (!composio) return void states.push(state("prices", "Stock prices", false, 0, "no Composio key"));
        const [prices, filings] = await Promise.all([
          attempt(() => composio.prices(`${company.ticker}:${company.exchange}`, deadline), deadline),
          attempt(() => composio.filings(company.ticker, deadline), deadline),
        ]);
        const closes = (prices.value?.points ?? []).filter((p) => p.close && p.day >= period.fromDay);
        const first = closes[0];
        const last = closes.at(-1);
        let priceItems = 0;
        if (first && last && first !== last) {
          const change = ((last.price - first.price) / first.price) * 100;
          if (Math.abs(change) >= PRICE_MOVE_PERCENT) {
            const c = prices.value!.currency;
            priceItems = 1;
            items.push({
              // The day in the link keeps each price move its own item.
              url: `https://www.google.com/finance/quote/${prices.value!.symbol}#${last.day}`,
              source: "company",
              sourceLabel: "Google Finance",
              title: `${company.name} (${company.ticker}) stock ${change > 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)}% since ${first.day}`,
              text: `${company.name} closed at ${first.price.toFixed(2)} ${c} on ${first.day} and at ${last.price.toFixed(2)} ${c} on ${last.day}, a change of ${change >= 0 ? "+" : ""}${change.toFixed(1)}%.`,
              publishedAt: last.day,
            });
          }
        }
        const filed = (filings.value?.filings ?? []).filter((f) => f.filedAt >= period.fromDay);
        for (const f of filed) {
          items.push({
            url: f.url,
            source: "company",
            sourceLabel: "SEC filings",
            title: `${filings.value!.companyName || company.name} ${f.form} filed ${f.filedAt}`,
            text: `${f.form} filing${f.reportDate ? ` for the period that ended ${f.reportDate}` : ""}.`,
            publishedAt: f.filedAt,
          });
        }
        states.push(state("prices", "Stock prices", !prices.error, priceItems, prices.error ?? "ok"));
        states.push(state("filings", "SEC filings", !filings.error, filed.length, filings.error ?? "ok"));
      })(),
    );
  }

  // The social sources are content goals (change content-router): the goals of the social source
  // ids, then the extra goals that the hints added to the lane plan.
  const extra: GoalRequest[] = (plan?.extraGoals ?? []).map((g) => ({
    id: customGoalId(g.kind),
    kind: g.kind,
    label: g.kind.charAt(0).toUpperCase() + g.kind.slice(1),
    query: g.query,
    ...(g.prefer ? { prefer: g.prefer } : {}),
  }));
  const goals = [...goalsOfSources(sources, deps.social), ...extra].filter((g, i, all) => all.findIndex((o) => o.id === g.id) === i);
  if (goals.length) {
    jobs.push(
      (async () => {
        const found = await searchSocial(goals, { query: plan?.socialQuery || lane.topic, sinceDay: period.fromDay, days: period.days, deadline }, deps.social);
        for (const source of goals.map((g) => g.id)) {
          const posts = found.posts
            .filter((p) => p.source === source)
            .sort((a, b) => preferredCounter(b.source, b.engagement).value - preferredCounter(a.source, a.engagement).value)
            .slice(0, POSTS_PER_SOURCE);
          // Data of the content router, for example prediction market odds, is published when the box fetched it.
          items.push(...posts.map((p) => ({ url: p.url, source: p.source, sourceLabel: p.sourceLabel, title: p.title, text: p.summary, publishedAt: p.publishedAt ?? period.to.slice(0, 10), engagement: p.engagement })));
        }
        states.push(...found.sources);
      })(),
    );
  }

  await Promise.all(jobs);
  return { items, sources: states, webSearches, webFailed };
}

/**
 * Collect every lane. Items get run keys, and an item that two lanes found stays in the first lane.
 * Throws `ResearchStepError` ("search") when every web search of the run failed.
 */
export async function collectRun(
  lanes: { lane: Lane; sources: ResearchSourceId[]; period: CollectPeriod }[],
  deadline: number,
  deps: CollectDeps,
): Promise<{ items: RunItem[]; sources: SourceState[] }> {
  const terms = runTerms(lanes.map((l) => l.lane.plan));
  const results = await Promise.all(lanes.map((l, i) => collectLane(l.lane, l.sources, l.period, deadline, deps, terms[i])));
  const searches = results.reduce((n, r) => n + r.webSearches, 0);
  const failed = results.reduce((n, r) => n + r.webFailed, 0);
  if (searches > 0 && failed === searches) throw new ResearchStepError("search", "every web search of the run failed");

  const seen = new Set<string>();
  const items: RunItem[] = [];
  results.forEach((r, i) => {
    for (const item of r.items) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      items.push({ ...item, key: `n${items.length + 1}`, laneId: lanes[i]!.lane.id });
    }
  });
  // One state for each source: the best state over the lanes.
  const rank = { "could not be reached": 0, "returned no items": 1, "returned items": 2 } as const;
  const byName = new Map<string, SourceState>();
  for (const s of results.flatMap((r) => r.sources)) {
    const cur = byName.get(s.name);
    if (!cur || rank[s.state] > rank[cur.state]) byName.set(s.name, s);
  }
  return { items, sources: [...byName.values()] };
}
