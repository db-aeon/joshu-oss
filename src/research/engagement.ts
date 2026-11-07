/**
 * Engagement numbers in the own unit of each source ("4.8k upvotes", "1.2M views"). The report
 * never adds views to upvotes. Restored from the formatter of the removed last30days app.
 */

import type { CollectedItem } from "./types.js";

export type NativeCounter = { value: number; unit: string };

export function formatCompactCount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = n / 1_000_000;
    return `${(abs >= 10_000_000 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "")}M`;
  }
  if (abs >= 1_000) {
    const v = n / 1_000;
    return `${(abs >= 10_000 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "")}k`;
  }
  return Math.round(n).toLocaleString("en-US");
}

function first(engagement: Record<string, number> | undefined, keys: string[]): number {
  for (const key of keys) {
    const v = engagement?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** The counter that means something for this source. Value 0 means the item has no number. */
export function preferredCounter(source: string, engagement?: Record<string, number>): NativeCounter {
  const src = source.toLowerCase();
  if (src === "reddit") return { value: first(engagement, ["score", "upvotes", "ups"]), unit: "upvotes" };
  if (src === "hackernews" || src === "hn") return { value: first(engagement, ["points", "score"]), unit: "points" };
  if (src === "github") return { value: first(engagement, ["stars", "reactions", "comments"]), unit: "reactions" };
  if (src === "polymarket") return { value: first(engagement, ["volume", "liquidity"]), unit: "volume" };
  if (["x", "youtube", "tiktok", "instagram", "threads"].includes(src)) {
    const views = first(engagement, ["views"]);
    if (views > 0) return { value: views, unit: "views" };
    return { value: first(engagement, ["likes", "score"]), unit: "likes" };
  }
  // Any other source, for example a content goal of a hint: the first known engagement metric.
  // A metric with another name, for example `odds`, is not engagement (change content-router, D6).
  for (const name of ENGAGEMENT_METRICS) {
    const v = first(engagement, [name]);
    if (v > 0) return { value: v, unit: name === "score" ? "points" : name };
  }
  return { value: 0, unit: "engagement" };
}

/** The metric names that count as engagement, in the order that the box prefers them. */
export const ENGAGEMENT_METRICS = ["views", "likes", "score", "upvotes", "points", "volume", "comments", "shares", "reposts", "replies"] as const;

/** The metrics of an item that are not engagement, for example `odds`, as "odds 0.42". Shown as they are. */
export function otherMetricLabels(engagement: Record<string, number> | undefined): string[] {
  const known = new Set<string>([...ENGAGEMENT_METRICS, "num_comments", "ups", "liquidity", "reactions", "stars"]);
  return Object.entries(engagement ?? {})
    .filter(([name, v]) => !known.has(name) && Number.isFinite(v))
    .map(([name, v]) => `${name} ${Number.isInteger(v) ? v : Number(v.toFixed(3))}`);
}

export function itemCounter(item: CollectedItem): NativeCounter {
  return preferredCounter(item.source, item.engagement);
}

/** "4.8k upvotes", or "" when the item has no number. Polymarket volume is in dollars. */
export function counterLabel(counter: NativeCounter): string {
  if (counter.value <= 0) return "";
  if (counter.unit === "volume") return `$${formatCompactCount(counter.value)} volume`;
  return `${formatCompactCount(counter.value)} ${counter.unit}`;
}

/** Sum of the counter for each source of `items`, largest first (by the log of the sum). */
export function totalsBySource(items: CollectedItem[]): { source: string; label: string; counter: NativeCounter; count: number }[] {
  const by = new Map<string, { source: string; label: string; counter: NativeCounter; count: number }>();
  for (const item of items) {
    const c = itemCounter(item);
    const cur = by.get(item.source) ?? { source: item.source, label: item.sourceLabel, counter: { value: 0, unit: c.unit }, count: 0 };
    cur.counter = { value: cur.counter.value + c.value, unit: c.unit };
    cur.count += 1;
    by.set(item.source, cur);
  }
  return [...by.values()].sort((a, b) => Math.log1p(b.counter.value) - Math.log1p(a.counter.value) || b.count - a.count);
}

/** Items ordered by their counter, compared across sources by the log of the value. */
export function strongestItems(items: CollectedItem[], n: number): CollectedItem[] {
  return [...items]
    .sort((a, b) => Math.log1p(itemCounter(b).value) - Math.log1p(itemCounter(a).value) || b.relevance - a.relevance)
    .slice(0, n);
}
