/**
 * The social posts of a Research report (change research-report-topics, design decision D1): the
 * content goals for the last 30 days, with the posts of each goal that have the most engagement.
 * The posts join the pool of the report like pages, and the group step leaves out the posts that
 * are not about the topic, so this step makes no model call. The box ranks the items of every goal
 * in the same way, whatever the provider endpoint. An item of an extra goal of a hint (for example
 * prediction market odds) can have no engagement number.
 */

import { itemCounter, strongestItems } from "../engagement.js";
import type { CollectedItem, SourceState } from "../types.js";
import { searchSocial, socialGoalKinds, type GoalRequest, type SocialDeps, type SocialPost } from "./sources.js";

/** The posts of one source that join the pool, as in a run of a recurring report. */
export const POOL_POSTS_PER_SOURCE = 10;
export const SOCIAL_WINDOW_DAYS = 30;

export type SocialPoolResult = { posts: CollectedItem[]; sources: SourceState[] };

/** The first day of a period of `days` that ends on `day` (`YYYY-MM-DD`). */
export function periodStart(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Give posts their identifiers (`s1`, `s2`, ...) as items of a Research report. */
export function asItems(posts: SocialPost[], prefix = "s"): CollectedItem[] {
  return posts.map((p, i) => ({ ...p, id: `${prefix}${i + 1}`, relevance: 0 }));
}

/** The first `n` items of a ranked list, with at most `perSource` from one source. */
export function capPerSource<T extends { source: string }>(ranked: T[], perSource: number, n: number): T[] {
  const count = new Map<string, number>();
  const out: T[] = [];
  for (const item of ranked) {
    if (out.length >= n) break;
    const c = count.get(item.source) ?? 0;
    if (c >= perSource) continue;
    count.set(item.source, c + 1);
    out.push(item);
  }
  return out;
}

/**
 * The social posts of the last 30 days for the pool of a Research report: for each goal, the posts
 * with the most engagement, at most `POOL_POSTS_PER_SOURCE`. A post of a default goal needs an
 * engagement number. Never throws: a failed search gives no posts and the state of each source.
 */
export async function collectSocialPool(
  query: string,
  day: string,
  deadline: number,
  deps: SocialDeps & { goals?: readonly GoalRequest[] } = {},
): Promise<SocialPoolResult> {
  const goals = deps.goals ?? socialGoalKinds(deps);
  const defaults = new Set(socialGoalKinds(deps).map((g) => g.id));
  const found = await searchSocial(goals, { query, sinceDay: periodStart(day, SOCIAL_WINDOW_DAYS), days: SOCIAL_WINDOW_DAYS, deadline }, deps);
  const items = asItems(found.posts).filter((p) => !defaults.has(p.source) || itemCounter(p).value > 0);
  const posts = capPerSource(strongestItems(items, items.length), POOL_POSTS_PER_SOURCE, POOL_POSTS_PER_SOURCE * Math.max(1, goals.length));
  return { posts: posts.map((p, i) => ({ ...p, id: `s${i + 1}` })), sources: found.sources };
}
