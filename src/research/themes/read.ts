/**
 * The read step of the themes (change research-report-topics, design decision D6). Each page and
 * post of a story becomes a page of the report, found by its theme. Exa reads the best web, news,
 * and paper pages of each theme in full, at most 4 for each theme and 20 for each report. A post or
 * an item of the content router counts as read with its own text.
 */

import type { ExaClient } from "../pipeline/exa.js";
import { resultPictures } from "../pipeline/exa.js";
import { pageText } from "../pipeline/extract.js";
import { withDeadline } from "../pipeline/llm.js";
import { normalizeUrl, siteOf } from "../pipeline/search.js";
import type { PageSource, WebPage } from "../types.js";
import type { StoryItem, UpdateStory } from "../recurring/types.js";
import type { ThemeDraft } from "./sort.js";

export const PAGES_PER_THEME = 4;
export const PAGES_PER_REPORT = 20;
/** A page with at least this much text is already read in full (the same limit as the fact step). */
const READ_TEXT = 1000;

const REDIRECT = /^https?:\/\/(www\.)?google\.com\/(goto|url)\b/;

function pageSource(item: Pick<StoryItem, "source" | "sourceLabel">): PageSource {
  if (item.source === "web" || item.source === "news") return item.source;
  if (item.source === "papers") return "scholar";
  if (item.source === "company") return item.sourceLabel === "SEC filings" ? "filings" : "prices";
  return "post";
}

/** The name of the site or the source of an item, for example "reuters.com" or "Reddit". */
export function itemSite(item: Pick<StoryItem, "url" | "source" | "sourceLabel">): string {
  if (REDIRECT.test(item.url)) return "Google News";
  return item.source === "web" || item.source === "news" ? siteOf(item.url) || item.sourceLabel : item.sourceLabel;
}

/** A page of the report for one item of a story. Its snippet or post text is its passage. */
export function storyItemPage(item: StoryItem, id: string): WebPage {
  return {
    id,
    url: item.url,
    title: item.title || itemSite(item),
    site: itemSite(item),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    highlights: item.text ? [item.text] : [],
    pictures: [],
    foundBy: [],
    foundVia: [pageSource(item)],
    score: 0,
  };
}

/** The items of a story: the new ones first. */
export function storyItems(story: UpdateStory): StoryItem[] {
  const fresh = new Set(story.newItems);
  return [...story.items.filter((i) => fresh.has(i.url)), ...story.items.filter((i) => !fresh.has(i.url))];
}

function readable(page: WebPage): boolean {
  return (page.foundVia.includes("web") || page.foundVia.includes("news") || page.foundVia.includes("scholar")) && !REDIRECT.test(page.url) && (page.text?.length ?? 0) < READ_TEXT;
}

/**
 * The pages of the report: `base` (the search pages of a Research report) and a page for each item
 * of the stories of the drafts, each found by its theme. Then Exa reads the best pages of each theme
 * in full. A failed read keeps the snippets, so the fact step still has text.
 */
export async function themePages(drafts: ThemeDraft[], stories: Map<string, UpdateStory>, base: WebPage[], exa: ExaClient | null, deadline: number): Promise<WebPage[]> {
  const pages = base.map((p) => ({ ...p, foundBy: [...p.foundBy] }));
  const byUrl = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  for (const draft of drafts) {
    for (const id of draft.storyIds) {
      const story = stories.get(id);
      if (!story) continue;
      for (const item of storyItems(story)) {
        const key = normalizeUrl(item.url);
        let page = byUrl.get(key);
        if (!page) {
          page = storyItemPage(item, `p${pages.length + 1}`);
          pages.push(page);
          byUrl.set(key, page);
        }
        if (!page.foundBy.includes(draft.id)) page.foundBy.push(draft.id);
      }
    }
  }

  const toRead: WebPage[] = [];
  for (const draft of drafts) {
    const mine = pages.filter((p) => p.foundBy.includes(draft.id) && readable(p) && !toRead.includes(p));
    toRead.push(...mine.slice(0, Math.min(PAGES_PER_THEME, PAGES_PER_REPORT - toRead.length)));
    if (toRead.length >= PAGES_PER_REPORT) break;
  }
  if (exa && toRead.length) {
    try {
      const results = await withDeadline(exa.contents(toRead.map((p) => p.url), deadline), deadline);
      const read = new Map(results.map((r) => [normalizeUrl(r.url), r]));
      for (const page of toRead) {
        const r = read.get(normalizeUrl(page.url));
        if (!r) continue;
        if (r.text && r.text.length > pageText(page).length) page.text = r.text;
        if (r.image && !page.image) page.image = r.image;
        if (!page.pictures.length) page.pictures = resultPictures(r);
        if (!page.publishedAt && r.publishedDate) page.publishedAt = r.publishedDate.slice(0, 10);
      }
    } catch {
      // The snippets stay the text of these pages.
    }
  }
  return pages;
}
