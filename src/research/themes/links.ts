/**
 * The links of a theme, built by code (change research-report-topics, design decision D9): the lead
 * link first, then the other pages and posts of the theme. The lead link is an item of the most
 * important story, with a news article before a web page before a post, and a direct link before a
 * Google News redirect. The model never writes a link.
 */

import { counterLabel, otherMetricLabels, preferredCounter } from "../engagement.js";
import { normalizeUrl } from "../pipeline/search.js";
import type { ReportSection, ThemeLink } from "../pipeline/write.js";
import type { Fact, WebPage } from "../types.js";
import type { StoryItem, UpdateStory } from "../recurring/types.js";
import { itemSite, storyItems } from "./read.js";

/** A theme shows its lead link and at most this many more links. */
export const MORE_LINKS = 8;

const REDIRECT = /^https?:\/\/(www\.)?google\.com\/(goto|url)\b/;
const SOURCE_RANK: Record<string, number> = { news: 0, web: 1, papers: 2, company: 3 };

function itemLink(item: StoryItem): ThemeLink {
  // A metric that is not engagement, for example the odds of a market, is shown as it is.
  const counter = counterLabel(preferredCounter(item.source, item.engagement)) || otherMetricLabels(item.engagement).join(", ");
  return {
    url: item.url,
    site: itemSite(item),
    title: item.title || itemSite(item),
    ...(item.publishedAt ? { publishedAt: item.publishedAt.slice(0, 10) } : {}),
    ...(counter ? { counter } : {}),
  };
}

function pageLink(page: WebPage): ThemeLink {
  return { url: page.url, site: page.site, title: page.title || page.site, ...(page.publishedAt ? { publishedAt: page.publishedAt.slice(0, 10) } : {}) };
}

/** The best lead item of a story: by source, and a direct link before a redirect. */
function leadOrder(items: StoryItem[]): StoryItem[] {
  return [...items].sort((a, b) => Number(REDIRECT.test(a.url)) - Number(REDIRECT.test(b.url)) || (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
}

/**
 * The links of one theme: the items of its stories in story order (the first story's best item
 * first), then the pages of its cited facts that no story has. At most `MORE_LINKS` after the lead.
 */
export function themeLinks(theme: Pick<ReportSection, "storyIds" | "factIds">, stories: Map<string, UpdateStory>, facts: Map<string, Fact>, pages: Map<string, WebPage>): ThemeLink[] {
  const out: ThemeLink[] = [];
  const seen = new Set<string>();
  const add = (link: ThemeLink) => {
    const key = normalizeUrl(link.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(link);
  };
  (theme.storyIds ?? []).forEach((id, i) => {
    const story = stories.get(id);
    if (!story) return;
    const items = storyItems(story);
    for (const item of i === 0 ? leadOrder(items) : items) add(itemLink(item));
  });
  for (const id of theme.factIds) {
    const page = pages.get(facts.get(id)?.pageId ?? "");
    if (page) add(pageLink(page));
  }
  // The lead link is a direct link when the theme has one.
  const direct = out.findIndex((l) => !REDIRECT.test(l.url));
  if (direct > 0) out.unshift(...out.splice(direct, 1));
  return out.slice(0, MORE_LINKS + 1);
}
