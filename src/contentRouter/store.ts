/**
 * The route cache and the shape cache of the box (change content-router, design decision D3). Both
 * are JSON files in the box skill `joshu-content-cache`, which the box makes at first use. The
 * skills seed does not merge that skill, because it is not a factory skill, so a release keeps the
 * data. Each write goes to a temporary file and then a rename, so two reports at once never leave a
 * half-written file: the last write wins, and both writes are valid.
 */

import fs from "node:fs";
import path from "node:path";
import { hermesHome } from "../proactive/boards.js";
import type { ShapeRecipe } from "./recipe.js";

export const CONTENT_CACHE_SKILL = "joshu-content-cache";

/** One entry of the route cache: the provider endpoint that serves a goal kind. */
export type RouteEntry = {
  endpoint: string;
  /** The input name of the query, for example `query` or `url`. */
  queryInput: string;
  /** Inputs that every call of this goal kind sends, for example `{"sort": "top"}`. */
  fixedInputs: Record<string, unknown>;
  /** The provider that a hint named when the box learned this route, for example `Polymarket`. */
  prefer?: string;
  origin: "seed" | "learned";
  learnedAt: string;
  lastSuccessAt?: string;
  /** Failures in a row. The box drops the entry at three. */
  failures: number;
  /**
   * Set on a failed entry: the box found no working provider endpoint for this goal kind, and it
   * does not learn again (or pay for a call) before this time. `endpoint` is then the one that failed, or empty.
   */
  retryAfter?: string;
  /** Why the entry failed, for example "returned no items". */
  reason?: string;
};

export type RoutesFile = { schemaVersion: 1; routes: Record<string, RouteEntry> };

export type ShapeEntry = ShapeRecipe & { origin: "seed" | "learned"; learnedAt: string };

export type ShapesFile = { schemaVersion: 1; shapes: Record<string, ShapeEntry> };

/** A route cache entry is dropped after this many failures in a row (risk 1 of design.md). */
export const MAX_ROUTE_FAILURES = 3;
/** A failed entry blocks a new learning of its goal kind for this many days. */
export const NO_ROUTE_RETRY_DAYS = 7;

const SEEDED_AT = "2026-11-01T00:00:00.000Z";

/** The goal kind as a key of the route cache: lower case, single spaces. */
export function goalKey(kind: string): string {
  return kind.trim().toLowerCase().replace(/\s+/g, " ");
}

function seedRoute(endpoint: string, queryInput: string, fixedInputs: Record<string, unknown> = {}): RouteEntry {
  return { endpoint, queryInput, fixedInputs, origin: "seed", learnedAt: SEEDED_AT, failures: 0 };
}

/**
 * The first route cache: the five default social goals, and the 15 provider endpoints of skill
 * `joshu-social-posts` (one post from its link), so that the first report makes no route model call.
 */
export function seedRoutes(): RoutesFile {
  const byLink: [string, string][] = [
    ["instagram post details", "scrapecreators.x.v1-instagram-post"],
    ["instagram video transcript", "scrapecreators.x.v2-instagram-media-transcript"],
    ["instagram post comments", "scrapecreators.instagram.post.comments"],
    ["facebook post details", "scrapecreators.x.v1-facebook-post"],
    ["facebook video transcript", "scrapecreators.x.v1-facebook-post-transcript"],
    ["facebook post comments", "scrapecreators.x.v1-facebook-post-comments"],
    ["tiktok video details", "scrapecreators.tiktok.video.detail"],
    ["tiktok video transcript", "scrapecreators.x.v1-tiktok-video-transcript"],
    ["tiktok video comments", "scrapecreators.tiktok.video.comments"],
    ["youtube video details", "scrapecreators.youtube.video.detail"],
    ["youtube video transcript", "scrapecreators.x.v1-youtube-video-transcript"],
    ["youtube video comments", "scrapecreators.youtube.video.comments"],
    ["threads post details", "scrapecreators.x.v1-threads-post"],
    ["linkedin post details", "scrapecreators.x.v1-linkedin-post"],
    ["linkedin video transcript", "scrapecreators.x.v1-linkedin-post-transcript"],
  ];
  return {
    schemaVersion: 1,
    routes: {
      "reddit posts": seedRoute("scrapecreators.reddit.search.posts", "query", { sort: "top", timeframe: "month" }),
      "youtube videos": seedRoute("scrapecreators.x.v1-youtube-search", "query", { uploadDate: "this_month" }),
      "tiktok videos": seedRoute("scrapecreators.tiktok.search.videos", "query", { sort_by: "relevance", date_posted: "this-month" }),
      "instagram reels": seedRoute("scrapecreators.x.v2-instagram-reels-search", "query", { date_posted: "last-month" }),
      "x posts": seedRoute("anyapi.x.search.posts", "query", { limit: 20 }),
      ...Object.fromEntries(byLink.map(([kind, endpoint]) => [kind, seedRoute(endpoint, "url")])),
    },
  };
}

function seedShape(recipe: ShapeRecipe): ShapeEntry {
  return { ...recipe, origin: "seed", learnedAt: SEEDED_AT };
}

/**
 * The first shape cache: the recipes of the four ScrapeCreators search endpoints, taken from the
 * readers that the social sources had before change content-router. Other endpoints are learned.
 */
export function seedShapes(): ShapesFile {
  return {
    schemaVersion: 1,
    shapes: {
      "scrapecreators.reddit.search.posts": seedShape({
        list: "posts",
        url: ["https://www.reddit.com{permalink}", "url"],
        title: "title",
        text: "selftext",
        author: ["subreddit.name", "subreddit"],
        publishedAt: { path: ["created_utc", "created_at"], format: "epoch_s" },
        metrics: { score: ["score", "ups"], comments: "num_comments" },
      }),
      "scrapecreators.x.v1-youtube-search": seedShape({
        list: "videos",
        url: ["url", "https://www.youtube.com/watch?v={id}"],
        title: "title",
        author: "channel.title",
        publishedAt: { path: ["publishedTime", "publishDate"], format: "text" },
        metrics: { views: "viewCountInt" },
      }),
      "scrapecreators.tiktok.search.videos": seedShape({
        list: "search_item_list",
        url: "https://www.tiktok.com/@{aweme_info.author.unique_id}/video/{aweme_info.aweme_id}",
        title: "aweme_info.desc",
        author: "aweme_info.author.unique_id",
        publishedAt: { path: "aweme_info.create_time", format: "epoch_s" },
        metrics: {
          views: "aweme_info.statistics.play_count",
          likes: "aweme_info.statistics.digg_count",
          comments: "aweme_info.statistics.comment_count",
          shares: "aweme_info.statistics.share_count",
        },
      }),
      "scrapecreators.x.v2-instagram-reels-search": seedShape({
        list: "reels",
        url: ["url", "https://www.instagram.com/reel/{shortcode}/"],
        title: ["caption.text", "caption"],
        author: ["owner.username", "user.username"],
        publishedAt: { path: "taken_at", format: "epoch_s" },
        metrics: { views: ["video_play_count", "video_view_count", "play_count"], likes: "like_count", comments: "comment_count" },
      }),
    },
  };
}

const SKILL_MD = `---
name: joshu-content-cache
description: What the box learned about the content router - the route cache, the shape cache, and the hints of the owner. The box writes the two JSON files; the companion reads them and adds hints.
metadata:
  hermes:
    category: research
    version: "1.0.0"
---

# Content cache

This skill belongs to this box. The skills seed of a release does not change it. Skill \`joshu-content-router\` tells how the companion uses the content router.

## Files

- \`references/routes.json\` is the route cache: for each kind of content goal (for example "youtube videos"), the provider endpoint that serves it, the input name of the query, the fixed inputs, the last success, and the failures in a row. The Joshu API writes it. Do not edit it by hand.
- \`references/shapes.json\` is the shape cache: for each provider endpoint, the recipe that turns its reply into items. The Joshu API writes it. Do not edit it by hand.

## Hints of the owner

Add a line here when the owner tells you which source to use for a kind of request, for example "Polymarket for prediction market odds on political topics". Pass the lines that fit a request in argument \`hints\` of \`research_report_make\` and \`research_recurring_save\`.

`;

export function contentCacheDir(home = hermesHome()): string {
  return path.join(home, "skills", CONTENT_CACHE_SKILL);
}

function routesPath(home: string): string {
  return path.join(contentCacheDir(home), "references", "routes.json");
}

function shapesPath(home: string): string {
  return path.join(contentCacheDir(home), "references", "shapes.json");
}

/** Write JSON with a temporary file and a rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Make the box skill `joshu-content-cache` with the seed files, when it is not there yet. */
export function ensureContentCache(home = hermesHome()): string {
  const dir = contentCacheDir(home);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  const skill = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skill)) fs.writeFileSync(skill, SKILL_MD, "utf8");
  if (!readJson<RoutesFile>(routesPath(home))?.routes) writeJsonAtomic(routesPath(home), seedRoutes());
  if (!readJson<ShapesFile>(shapesPath(home))?.shapes) writeJsonAtomic(shapesPath(home), seedShapes());
  return dir;
}

export function readRoutes(home = hermesHome()): RoutesFile {
  ensureContentCache(home);
  return readJson<RoutesFile>(routesPath(home)) ?? seedRoutes();
}

export function readShapes(home = hermesHome()): ShapesFile {
  ensureContentCache(home);
  return readJson<ShapesFile>(shapesPath(home)) ?? seedShapes();
}

/** Read the route cache, change one entry, and write it back. `undefined` from `change` removes the entry. */
export function updateRoute(kind: string, change: (current: RouteEntry | undefined) => RouteEntry | undefined, home = hermesHome()): void {
  const file = readRoutes(home);
  const key = goalKey(kind);
  const next = change(file.routes[key]);
  if (next) file.routes[key] = next;
  else delete file.routes[key];
  writeJsonAtomic(routesPath(home), file);
}

/** Read the shape cache, set the recipe of one provider endpoint, and write it back. */
export function saveShape(endpoint: string, recipe: ShapeRecipe, at: string, home = hermesHome()): void {
  const file = readShapes(home);
  file.shapes[endpoint] = { ...recipe, origin: "learned", learnedAt: at };
  writeJsonAtomic(shapesPath(home), file);
}
