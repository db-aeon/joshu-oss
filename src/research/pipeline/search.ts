/**
 * Search and rank steps of the research pipeline: two Exa searches for each sub-question (recent
 * and evergreen), duplicate removal, at most two pages for each site, a content-farm deny list,
 * and the full text and images of the best pages. Design decision D1. Each search term of a
 * sub-question adds one recent Exa search (change research-keyword-expansion). With Composio Search, the
 * news, the papers, and the company pages join the pages (change research-report-sources, D3 to D7).
 */

import { ResearchStepError } from "../errors.js";
import type { PageSource, ResearchPlan, SourceState, WebPage } from "../types.js";
import { collectCompany } from "./company.js";
import type { ComposioSearchClient } from "./composioSearch.js";
import { resultPictures, searchAll, type ExaClient, type ExaResult } from "./exa.js";
import { mapLimit, withDeadline } from "./llm.js";

export const PAGES_KEPT = 24;
export const PAGES_READ_IN_FULL = 12;
const MAX_PAGES_PER_SITE = 2;
const RECENT_DAYS = 30;
/** The Exa results of one search term, which is narrower than a query of a sub-question (change research-keyword-expansion). */
export const TERM_RESULTS = 5;
/**
 * The passage score of a news hit or a paper hit, which has no score of its own (D3). It only
 * orders the pages: news never takes the place of an Exa page.
 */
export const FIXED_PASSAGE_SCORE = 0.3;
/** News articles that only the news search found, added to the Exa pages, and how many of them are read in full (D3). */
export const NEWS_PAGES_KEPT = 6;
export const NEWS_PAGES_READ_IN_FULL = 3;

/** Sites that rank well but rarely add facts. Exa excludes them in the search. */
export const EXCLUDED_DOMAINS = [
  "pinterest.com",
  "quora.com",
  "medium.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "reddit.com",
  "scribd.com",
  "slideshare.net",
  "coursehero.com",
  "studocu.com",
];

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** URL without query, hash, and trailing slash, for duplicate checks. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

function dayOf(value: string | undefined): string | undefined {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
}

/** The results of one search: the sub-question, the source (default `web`, the Exa search), and the hits. */
export type FoundHits = { subQuestionId: string; via?: PageSource; results: ExaResult[] };

/**
 * Merge the results of all searches into ranked pages. A page found by several searches or near
 * the top of a search scores higher. At most two pages for each site.
 */
export function rankPages(found: FoundHits[], limit = PAGES_KEPT): WebPage[] {
  const byUrl = new Map<string, WebPage>();
  for (const { subQuestionId, via = "web", results } of found) {
    results.forEach((r, rank) => {
      if (!r.url) return;
      const site = siteOf(r.url);
      if (!site || EXCLUDED_DOMAINS.some((d) => site === d || site.endsWith(`.${d}`))) return;
      const key = normalizeUrl(r.url);
      const highlightScore = r.highlightScores?.length
        ? Math.max(0, ...r.highlightScores)
        : via === "web"
          ? 0
          : FIXED_PASSAGE_SCORE;
      const points = 1 / (rank + 1) + highlightScore;
      const page = byUrl.get(key);
      if (page) {
        if (!page.foundBy.includes(subQuestionId)) page.foundBy.push(subQuestionId);
        if (!page.foundVia.includes(via)) page.foundVia.push(via);
        page.score += points + 0.5;
        for (const h of r.highlights ?? []) if (!page.highlights.includes(h)) page.highlights.push(h);
        if (!page.publishedAt) page.publishedAt = dayOf(r.publishedDate);
        return;
      }
      byUrl.set(key, {
        id: "",
        url: r.url,
        title: (r.title ?? "").trim() || site,
        site,
        publishedAt: dayOf(r.publishedDate),
        highlights: [...(r.highlights ?? [])],
        image: r.image || undefined,
        pictures: resultPictures(r),
        foundBy: [subQuestionId],
        foundVia: [via],
        score: points,
      });
    });
  }
  const perSite = new Map<string, number>();
  const kept: WebPage[] = [];
  for (const page of [...byUrl.values()].sort((a, b) => b.score - a.score)) {
    const n = perSite.get(page.site) ?? 0;
    if (n >= MAX_PAGES_PER_SITE) continue;
    perSite.set(page.site, n + 1);
    kept.push(page);
    if (kept.length >= limit) break;
  }
  return kept.map((page, i) => ({ ...page, id: `p${i + 1}` }));
}

function startDate(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - RECENT_DAYS * 86_400_000).toISOString();
}

type ExtraSearch = { subQuestionId: string; via: "news" | "scholar"; run: () => Promise<ExaResult[]> };

/** The source state of the news or the paper searches (D7). */
function extraState(name: string, label: string, answers: { results: ExaResult[]; error?: string }[]): SourceState {
  const failed = answers.filter((a) => a.error).length;
  const found = answers.some((a) => a.results.length);
  if (failed === answers.length) return { name, label, state: "could not be reached", engineStatus: answers[0]?.error ?? "error" };
  return {
    name,
    label,
    state: found ? "returned items" : "returned no items",
    engineStatus: failed ? `${failed} of ${answers.length} searches failed` : "ok",
  };
}

/**
 * Search the web for each sub-question and read the best pages in full. With Composio Search, the
 * news, paper, and company calls run at the same time as the Exa searches, and a failed Composio
 * call only gives fewer pages (D6). Throws `ResearchStepError` ("search") when every Exa search
 * fails, because the facts come from the web.
 */
export async function searchWeb(
  client: ExaClient,
  plan: ResearchPlan,
  day: string,
  deadline: number,
  composio: ComposioSearchClient | null = null,
): Promise<{ pages: WebPage[]; failed: number; total: number; extraSources: SourceState[] }> {
  const requests = plan.subQuestions.flatMap((q) => [
    { subQuestionId: q.id, req: { query: q.recentQuery, startPublishedDate: startDate(day), excludeDomains: EXCLUDED_DOMAINS, highlightsQuery: q.question } },
    { subQuestionId: q.id, req: { query: q.evergreenQuery, excludeDomains: EXCLUDED_DOMAINS, highlightsQuery: q.question } },
    // Each search term of the sub-question, by name, in the last 30 days (change research-keyword-expansion).
    ...(q.terms ?? []).map((query) => ({
      subQuestionId: q.id,
      req: { query, numResults: TERM_RESULTS, startPublishedDate: startDate(day), excludeDomains: EXCLUDED_DOMAINS, highlightsQuery: q.question },
    })),
  ]);
  const extras: ExtraSearch[] = composio
    ? plan.subQuestions.flatMap((q) => [
        { subQuestionId: q.id, via: "news" as const, run: () => composio.news(q.recentQuery, deadline) },
        ...(q.scholarQuery ? [{ subQuestionId: q.id, via: "scholar" as const, run: () => composio.scholar(q.scholarQuery!, deadline) }] : []),
      ])
    : [];
  const readPassages = async (urls: string[]) => {
    const byUrl = new Map<string, string[]>();
    const keyOf = (u: string) => normalizeUrl(u).replace(/\.html?$/, "");
    const wanted = new Map(urls.map((u) => [keyOf(u), u]));
    for (const r of await client.contents(urls, deadline, { highlightsQuery: plan.brief })) {
      const url = wanted.get(keyOf(r.url)) ?? (r.id ? wanted.get(keyOf(r.id)) : undefined);
      if (url && r.highlights?.length) byUrl.set(url, r.highlights);
    }
    return byUrl;
  };

  const [answers, extraAnswers, company] = await Promise.all([
    searchAll(client, requests.map((r) => r.req), deadline),
    mapLimit(extras, extras.length || 1, async (e) => {
      try {
        return { results: await withDeadline(e.run(), deadline) };
      } catch (err) {
        return { results: [] as ExaResult[], error: (err as Error).message };
      }
    }),
    composio && plan.company ? collectCompany(composio, plan.company, readPassages, deadline) : null,
  ]);
  const failed = answers.filter((a) => a.error).length;
  if (failed === answers.length) {
    throw new ResearchStepError("search", answers[0]?.error ?? "the web search failed");
  }
  // The Exa pages are chosen from the Exa results alone, exactly as without Composio Search, so
  // news and papers add pages and never take the place of an Exa page (D3).
  const webFound = answers.map((a, i) => ({ subQuestionId: requests[i]!.subQuestionId, results: a.results }));
  const extraFound = extraAnswers.map((a, i) => ({ subQuestionId: extras[i]!.subQuestionId, via: extras[i]!.via, results: a.results }));
  const merged = rankPages([...webFound, ...extraFound], Number.POSITIVE_INFINITY);
  const mergedByKey = new Map(merged.map((p) => [normalizeUrl(p.url), p]));
  const webPages = rankPages(webFound).map((p) => mergedByKey.get(normalizeUrl(p.url)) ?? p);
  const webKeys = new Set(webPages.map((p) => normalizeUrl(p.url)));
  const notWeb = (p: WebPage) => !webKeys.has(normalizeUrl(p.url));
  const newsPages = merged.filter((p) => notWeb(p) && p.foundVia.includes("news")).slice(0, NEWS_PAGES_KEPT);

  // The top paper of each Google Scholar search is read in full, because the snippet of a paper is
  // too short for facts (D3). Other papers are left out.
  const topPaperKeys = new Set(
    extraAnswers.flatMap((a, i) => (extras[i]!.via === "scholar" && a.results[0]?.url ? [normalizeUrl(a.results[0].url)] : [])),
  );
  const topPapers = merged.filter((p) => topPaperKeys.has(normalizeUrl(p.url)) && notWeb(p) && !newsPages.includes(p));

  const byScore = (a: WebPage, b: WebPage) => b.score - a.score;
  const read = [...webPages.slice(0, PAGES_READ_IN_FULL), ...newsPages.slice(0, NEWS_PAGES_READ_IN_FULL)].sort(byScore);
  const rest = [...webPages.slice(PAGES_READ_IN_FULL), ...newsPages.slice(NEWS_PAGES_READ_IN_FULL)].sort(byScore);
  const pages = [...topPapers, ...read, ...rest];

  // Full text and page images of the best pages and the top papers (one call; a failure keeps the highlights only).
  const best = [...topPapers, ...read];
  try {
    const contents = await client.contents(best.map((p) => p.url), deadline);
    const byUrl = new Map(contents.map((c) => [normalizeUrl(c.url), c]));
    for (const page of best) {
      const c = byUrl.get(normalizeUrl(page.url));
      if (!c) continue;
      if (c.text) page.text = c.text;
      const pics = resultPictures(c);
      if (pics.length) page.pictures = pics;
      if (!page.image && c.image) page.image = c.image;
    }
  } catch {
    /* the highlights are enough to extract facts */
  }

  // The company pages come first, then the top papers, so that the fact extraction reads them (D3, D4, D5).
  const allQuestions = plan.subQuestions.map((q) => q.id);
  const companyPages = (company?.pages ?? []).map((p) => ({ ...p, foundBy: allQuestions }));
  const numbered = [...companyPages, ...pages].map((page, i) => ({ ...page, id: `p${i + 1}` }));

  const extraSources: SourceState[] = [];
  const news = extraAnswers.filter((_, i) => extras[i]!.via === "news");
  const papers = extraAnswers.filter((_, i) => extras[i]!.via === "scholar");
  if (news.length) extraSources.push(extraState("news", "News (Google News)", news));
  if (papers.length) extraSources.push(extraState("scholar", "Research papers (Google Scholar)", papers));
  if (company) extraSources.push(...company.sources);
  return { pages: numbered, failed, total: answers.length, extraSources };
}
