/**
 * The group and compare steps of a run, and the stored stories (design decisions D3 and D4).
 *
 * First, one model call groups the items of all lanes into stories and leaves out the items that are
 * not about a lane and the pages that report no event (change research-report-topics, D3 and D4).
 * A run with more than `ONE_GROUP_CALL_ITEMS` items groups each lane on its own. Second, an item whose link is in a stored story joins that
 * story, with no model call. Third, one model call matches the other stories of all lanes with the
 * stored stories of the last 60 days, and with each other across lanes. Each story then gets its
 * story status, as the glossary defines it.
 */

import { aboutLines } from "../pipeline/extract.js";
import { asString, asStringArray, callJson, mapLimit, type JsonCallOpts } from "../pipeline/llm.js";
import type { RunItem } from "./collect.js";
import type { Lane, StoriesFile, StoredStory, StoryItem, StoryStatus, UpdateStory } from "./types.js";

/** A stored story that no run found for this long is dropped. Only these stories are compared. */
export const STORY_KEEP_DAYS = 60;
const DAY_MS = 86_400_000;

export type Llm = Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot">;

/** A story of one lane of one run, before the compare step. */
export type RunStory = { key: string; laneId: string; title: string; summary: string; items: RunItem[] };

/**
 * The output limit of one group call. A story with its title, summary, and item keys takes 60 to 80
 * tokens, and a pool can have almost one story for each item. With 40 tokens for each item, a live
 * Research report of 2026-11-02 with 61 items got an answer cut off in the middle of the JSON.
 */
export function groupMaxTokens(items: number): number {
  return Math.min(12_000, 600 + 120 * items);
}

/** Above this many items, each lane is grouped in its own call, so that one prompt stays small (D3). */
export const ONE_GROUP_CALL_ITEMS = 120;

const GROUP_SYSTEM = `You group the news items of a report into stories.
Return JSON only: {"stories": [{"title": string, "summary": string, "items": [string]}]}
Rules:
- A story is one event or one subject: for example one contract, one product launch, one study, one lawsuit. Items from different sources about the same event are one story.
- items: the item keys, for example "n3". Each item is in at most one story.
- Leave out items that are not about a topic of the report, and items that are ads, spam, or jokes without content. An item is about a topic only when its main subject is what "About" describes, not when it only shares some words with the topic.
- Leave out pages that report no event: product pages, vendor guides, comparisons and lists of top products, and marketing pages. A news article, an announcement, a study, a filing, or a post about something that happened is an event.
- "About" says what a topic means, and "Not about" lists things with a similar name. Leave out items about those other things, also when an item mixes the two up. Follow the notes of the owner on what the topic means.
- "Follows" lists the companies, products, and words of the space that a topic covers, for example its competitors. Items about them are about the topic.
- title: a plain headline of at most twelve words that names the event. summary: one plain sentence on what happened, using only the items.
- The most important story first.`;

function itemLine(item: RunItem): string {
  const text = item.text ? ` | ${item.text.slice(0, 200)}` : "";
  return `[${item.key}] ${item.sourceLabel}${item.publishedAt ? ` ${item.publishedAt}` : ""}: ${item.title.slice(0, 200)}${text}`;
}

function topicLines(lanes: Lane[]): string {
  if (lanes.length === 1) return `Topic: ${lanes[0]!.topic}\n${lanes[0]!.plan ? aboutLines(lanes[0]!.plan) : ""}`;
  return `Topics:\n${lanes.map((l) => `- ${l.topic}\n${l.plan ? aboutLines(l.plan).replace(/^/gm, "  ").trimEnd() + "\n" : ""}`).join("")}`;
}

/**
 * Group the items of all lanes in one model call, or, above `ONE_GROUP_CALL_ITEMS` items, the items
 * of each lane in its own call, at most four at once. A story belongs to the lane of its first item.
 * Throws `ResearchStepError` ("group").
 */
export async function groupStories(lanes: Lane[], items: RunItem[], deadline: number, llm: Llm = {}, notes = ""): Promise<RunStory[]> {
  const groups = items.length > ONE_GROUP_CALL_ITEMS ? lanes.map((lane) => [lane]) : [lanes];
  const perGroup = await mapLimit(groups, 4, async (group) => {
    const ids = new Set(group.map((l) => l.id));
    const mine = items.filter((i) => ids.has(i.laneId));
    if (!mine.length) return [];
    const byKey = new Map(mine.map((i) => [i.key, i]));
    const { value } = await callJson<{ title: string; summary: string; items: RunItem[] }[]>({
      ...llm,
      step: "group",
      system: GROUP_SYSTEM,
      user: `${topicLines(group)}${notes.trim() ? `Notes of the owner: ${notes.trim()}\n` : ""}\nItems:\n${mine.map(itemLine).join("\n")}`,
      deadline,
      maxTokens: groupMaxTokens(mine.length),
      check: (raw) => {
        const list = raw && typeof raw === "object" ? (raw as { stories?: unknown }).stories : undefined;
        if (!Array.isArray(list)) return null;
        const used = new Set<string>();
        return list.flatMap((s) => {
          const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
          const storyItems = asStringArray(o.items).filter((k) => byKey.has(k) && !used.has(k));
          const title = asString(o.title);
          if (!title || !storyItems.length) return [];
          storyItems.forEach((k) => used.add(k));
          return [{ title, summary: asString(o.summary), items: storyItems.map((k) => byKey.get(k)!) }];
        });
      },
    });
    return value.map((s) => ({ ...s, laneId: s.items[0]!.laneId }));
  });
  return perGroup.flat().map((s, i) => ({ ...s, key: `r${i + 1}` }));
}

const COMPARE_SYSTEM = `You match the stories of today's news digest with the stories of earlier digests, and with each other.
Return JSON only: {"matches": [{"story": string, "earlier": string}], "same": [{"story": string, "as": string}]}
Rules:
- matches: a story of today (key "r…") and an earlier story (key "S…") about the same event or subject. A new development of the same event is still the same story. Leave out a story of today that no earlier story is about.
- same: two stories of today in different topics about the same event. "as" is the story of the earlier topic in the list.
- Only match when you are sure. Two different events of the same company are different stories.`;

export type CompareResult = {
  stories: UpdateStory[];
  /** The next free story number, for the identifiers of new stories. */
  nextNumber: number;
};

function storyItem(item: RunItem, run: string): StoryItem {
  return {
    url: item.url,
    source: item.source,
    sourceLabel: item.sourceLabel,
    title: item.title,
    ...(item.text ? { text: item.text } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.engagement && Object.keys(item.engagement).length ? { engagement: item.engagement } : {}),
    firstRun: run,
  };
}

/** The names of the sources of a story, for example "Web and news", "Reddit". */
export function storySources(items: Pick<StoryItem, "source">[]): string[] {
  const label = (s: string) => (s === "web" || s === "news" ? "Web and news" : s === "papers" ? "Research papers" : s === "company" ? "Company data" : { reddit: "Reddit", x: "X", youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" }[s] ?? s);
  return [...new Set(items.map((i) => label(i.source)))];
}

/** The stored stories that a run compares with: found in the last 60 days. */
export function recentStories(file: StoriesFile, now: Date): StoredStory[] {
  return file.stories.filter((s) => now.getTime() - Date.parse(s.lastRun) <= STORY_KEEP_DAYS * DAY_MS);
}

/**
 * Compare the stories of a run with the stored stories and give each its story status. Stories of
 * a lane in `startingLanes` are compared with no stored story, so they are all new (spec: "The first
 * report update is a starting update"). Throws `ResearchStepError` ("compare").
 */
export async function compareStories(
  runStories: RunStory[],
  file: StoriesFile,
  opts: { lanes: Lane[]; startingLanes: Set<string>; run: string; now: Date; deadline: number; llm?: Llm },
): Promise<CompareResult> {
  const stored = recentStories(file, opts.now);
  const storedById = new Map(stored.map((s) => [s.id, s]));
  const laneOrder = new Map(opts.lanes.map((l, i) => [l.id, i]));
  const comparable = (rs: RunStory) => !opts.startingLanes.has(rs.laneId);

  // Links first: the stored story with the most links of the run story.
  const matchOf = new Map<string, string>();
  const byUrl = new Map<string, string>();
  for (const s of stored) for (const it of s.items) byUrl.set(it.url, s.id);
  for (const rs of runStories) {
    if (!comparable(rs)) continue;
    const counts = new Map<string, number>();
    for (const it of rs.items) {
      const id = byUrl.get(it.url);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) matchOf.set(rs.key, best[0]);
  }

  // Then one model call over the remaining stories of all lanes.
  const sameAs = new Map<string, string>();
  const remaining = runStories.filter((rs) => !matchOf.has(rs.key));
  const candidates = stored.filter((s) => runStories.some((rs) => comparable(rs) && !matchOf.has(rs.key)));
  const lanesWithStories = new Set(runStories.map((rs) => rs.laneId));
  if (remaining.length && (candidates.length || lanesWithStories.size > 1)) {
    const laneTopic = new Map(opts.lanes.map((l) => [l.id, l.topic]));
    const user = [
      "Stories of today:",
      ...remaining.map((rs) => `[${rs.key}] (topic: ${laneTopic.get(rs.laneId)}${comparable(rs) ? "" : ", new topic: match with no earlier story"}) ${rs.title}. ${rs.summary}`),
      "",
      "Earlier stories:",
      ...(candidates.length ? candidates.map((s) => `[${s.id}] (topic: ${laneTopic.get(s.laneId) ?? "removed topic"}) ${s.title}. ${s.summary}`) : ["none"]),
    ].join("\n");
    const known = new Set(remaining.map((r) => r.key));
    const { value } = await callJson<{ matches: [string, string][]; same: [string, string][] }>({
      ...opts.llm,
      step: "compare",
      system: COMPARE_SYSTEM,
      user,
      deadline: opts.deadline,
      maxTokens: 300 + 30 * remaining.length,
      check: (raw) => {
        if (!raw || typeof raw !== "object") return null;
        const o = raw as { matches?: unknown; same?: unknown };
        const pairs = (list: unknown, a: string, b: string) =>
          (Array.isArray(list) ? list : []).flatMap((m) => {
            const r = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
            return [[asString(r[a]), asString(r[b])] as [string, string]];
          });
        return { matches: pairs(o.matches, "story", "earlier"), same: pairs(o.same, "story", "as") };
      },
    });
    for (const [story, earlier] of value.matches) {
      const rs = runStories.find((r) => r.key === story);
      if (rs && known.has(story) && comparable(rs) && storedById.has(earlier) && !matchOf.has(story)) matchOf.set(story, earlier);
    }
    for (const [story, as] of value.same) {
      if (known.has(story) && known.has(as) && story !== as) sameAs.set(story, as);
    }
  }

  // Merge run stories: stories that match the same stored story, and stories that are the same event.
  const groups = new Map<string, RunStory[]>();
  const root = (key: string): string => {
    let k = key;
    for (let i = 0; i < 10 && sameAs.has(k); i += 1) k = sameAs.get(k)!;
    return k;
  };
  for (const rs of runStories) {
    const matched = matchOf.get(rs.key) ?? matchOf.get(root(rs.key));
    const groupKey = matched ? `stored:${matched}` : `run:${root(rs.key)}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), rs]);
  }

  let nextNumber = file.nextNumber;
  const out: UpdateStory[] = [];
  for (const [groupKey, members] of groups) {
    // The story is shown in the first lane that found it.
    members.sort((a, b) => (laneOrder.get(a.laneId) ?? 99) - (laneOrder.get(b.laneId) ?? 99));
    const lead = members[0]!;
    const storedStory = groupKey.startsWith("stored:") ? storedById.get(groupKey.slice(7)) : undefined;
    const items = members.flatMap((m) => m.items).map((it) => storyItem(it, opts.run));
    const known = new Set(storedStory?.items.map((i) => i.url) ?? []);
    const fresh = items.filter((i) => !known.has(i.url));
    const status: StoryStatus = !storedStory ? "new" : fresh.length ? "developing" : "quiet";
    const laneId = storedStory && laneOrder.has(storedStory.laneId) ? storedStory.laneId : lead.laneId;
    const allItems = storedStory ? [...storedStory.items, ...fresh] : items;
    out.push({
      id: storedStory?.id ?? `S${nextNumber++}`,
      laneId,
      title: lead.title,
      summary: lead.summary || storedStory?.summary || "",
      status,
      sources: storySources(allItems),
      items: allItems,
      newItems: fresh.map((i) => i.url),
    });
  }
  return { stories: rankStories(out, laneOrder), nextNumber };
}

/** The weight of a story: its new items and, counted twice, the sources of its new items. */
export function storyWeight(s: UpdateStory): number {
  const fresh = s.items.filter((i) => s.newItems.includes(i.url));
  return fresh.length + 2 * storySources(fresh).length;
}

/** Order stories by weight, then by lane: the theme step gets the most important stories first (change research-report-topics). */
export function rankStories(stories: UpdateStory[], laneOrder: Map<string, number>): UpdateStory[] {
  return [...stories].sort((a, b) => storyWeight(b) - storyWeight(a) || (laneOrder.get(a.laneId) ?? 99) - (laneOrder.get(b.laneId) ?? 99));
}

/**
 * The stored stories after a run that worked: new items join their stories, new stories are added,
 * and stories that no run found for 60 days are dropped. `shown` names the stories of the digest.
 */
export function applyRun(file: StoriesFile, result: CompareResult, opts: { run: string; now: Date; shown: Set<string> }): StoriesFile {
  const at = opts.now.toISOString();
  const stories = new Map(file.stories.map((s) => [s.id, structuredClone(s)]));
  for (const story of result.stories) {
    const cur = stories.get(story.id);
    if (cur) {
      const known = new Set(cur.items.map((i) => i.url));
      cur.items.push(...story.items.filter((i) => !known.has(i.url)));
      cur.lastRun = at;
      cur.title = story.title;
      if (story.summary) cur.summary = story.summary;
      if (opts.shown.has(story.id)) cur.lastShownRun = opts.run;
    } else {
      stories.set(story.id, {
        id: story.id,
        laneId: story.laneId,
        title: story.title,
        summary: story.summary,
        firstRun: at,
        lastRun: at,
        ...(opts.shown.has(story.id) ? { lastShownRun: opts.run } : {}),
        items: story.items,
      });
    }
  }
  const kept = [...stories.values()].filter((s) => opts.now.getTime() - Date.parse(s.lastRun) <= STORY_KEEP_DAYS * DAY_MS);
  return { schemaVersion: 1, nextNumber: Math.max(file.nextNumber, result.nextNumber), stories: kept };
}

const PAGE_SOURCE: Record<string, string> = { web: "web", news: "news", scholar: "papers", prices: "company", filings: "company" };

/**
 * The stored stories of a one-time Research report (design decision D4): each theme section becomes
 * one story with its cited pages, so a repeat request can compare with the report (D8).
 */
export function reportStories(
  research: { pages: { id: string; url: string; title: string; site: string; publishedAt?: string; highlights: string[]; foundVia: string[] }[]; facts: { id: string; pageId: string }[] },
  themes: { title: string; label: string; factIds: string[] }[],
  run: string,
  at: string,
): StoriesFile {
  const pages = new Map(research.pages.map((p) => [p.id, p]));
  const facts = new Map(research.facts.map((f) => [f.id, f]));
  const stories: StoredStory[] = [];
  for (const theme of themes) {
    const cited = [...new Set(theme.factIds.map((id) => facts.get(id)?.pageId).filter((id): id is string => Boolean(id)))];
    const items: StoryItem[] = cited.flatMap((pageId) => {
      const p = pages.get(pageId);
      if (!p) return [];
      return [
        {
          url: p.url,
          source: PAGE_SOURCE[p.foundVia[0] ?? "web"] ?? "web",
          sourceLabel: p.site,
          title: p.title,
          ...(p.highlights[0] ? { text: p.highlights[0].slice(0, 600) } : {}),
          ...(p.publishedAt ? { publishedAt: p.publishedAt.slice(0, 10) } : {}),
          firstRun: run,
        },
      ];
    });
    if (!items.length) continue;
    stories.push({ id: `S${stories.length + 1}`, laneId: "l1", title: theme.title, summary: theme.label, firstRun: at, lastRun: at, lastShownRun: run, items });
  }
  return { schemaVersion: 1, nextNumber: stories.length + 1, stories };
}
