/**
 * The content goals client (change content-router, design decisions D2 and D5). `resolveGoal`
 * turns a content goal, for example "YouTube videos: humanoid robots", into one router call and
 * items:
 * 1. Look up the goal kind in the route cache.
 * 2. On a miss, search the router catalog, pick a provider endpoint with one model call, and keep
 *    the choice when the call returns items.
 * 3. Call the provider endpoint.
 * 4. Look up the shape recipe of the provider endpoint.
 * 5. On a miss, or when the recipe fails its check on a reply with a list, learn the recipe with
 *    one model call, and keep it. A recipe that fails again gives the state "could not be read".
 * 6. Return the items.
 * A goal never throws: a failure gives its source the state "could not be reached" with the reason.
 */

import fs from "node:fs";
import path from "node:path";
import { limiter } from "../research/pipeline/llm.js";
import { hermesHome } from "../proactive/boards.js";
import type { SourceState } from "../research/types.js";
import { RouterError, type RouterClient, type RouterFailure, type RouterUnavailable } from "./client.js";
import { cleanFixedInputs, ENDPOINT_ID_PATTERN, INPUT_NAME_PATTERN, learnRecipe, learnRoute, matchesPrefer, type LearnLlm } from "./learn.js";
import { applyRecipe, checkItems, checkRecipe, longestList, type RecipeItem, type ShapeRecipe } from "./recipe.js";
import { goalKey, MAX_ROUTE_FAILURES, NO_ROUTE_RETRY_DAYS, readRoutes, readShapes, saveShape, updateRoute, type RouteEntry } from "./store.js";

/** A content goal of one source of a report. */
export type ContentGoal = {
  /** The source id of the goal in a report, for example `youtube` or `goal:prediction market odds`. */
  id: string;
  /** The kind of source, for example "YouTube videos". The key of the route cache. */
  kind: string;
  /** The name of the source for the owner, for example "YouTube". */
  label: string;
  /** The search words, for example "humanoid robots". */
  query: string;
  /** The provider that a hint names for this goal, for example "Polymarket". */
  prefer?: string;
};

/** A default goal without its query. */
export type GoalKind = Omit<ContentGoal, "query" | "prefer">;

/** The default social goals when skill `joshu-content-router` cannot be read. The ids are the old source ids. */
export const BUILT_IN_SOCIAL_GOALS: readonly GoalKind[] = [
  { id: "reddit", kind: "Reddit posts", label: "Reddit" },
  { id: "youtube", kind: "YouTube videos", label: "YouTube" },
  { id: "tiktok", kind: "TikTok videos", label: "TikTok" },
  { id: "instagram", kind: "Instagram reels", label: "Instagram" },
  { id: "x", kind: "X posts", label: "X" },
];

export const CONTENT_ROUTER_SKILL = "joshu-content-router";

/** Parse the table of section "Default social goals" of skill `joshu-content-router`: `| id | goal | label |`. */
export function parseDefaultGoals(markdown: string): GoalKind[] {
  const section = markdown.split(/^## /m).find((s) => s.toLowerCase().startsWith("default social goals"));
  if (!section) return [];
  const out: GoalKind[] = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim().replace(/^`|`$/g, ""));
    if (cells.length < 5 || !/^[a-z][a-z0-9_-]*$/.test(cells[1] ?? "") || cells[1] === "id") continue;
    const [, id, kind, label] = cells;
    if (id && kind && label && !out.some((g) => g.id === id)) out.push({ id, kind, label });
  }
  return out;
}

/**
 * The default social goals: from the box copy of skill `joshu-content-router`, then the copy in the
 * release, then the built-in list. So a new default is a skill change (design D5).
 */
export function defaultSocialGoals(projectRoot = process.cwd(), home = hermesHome()): GoalKind[] {
  const files = [
    path.join(home, "skills", "research", CONTENT_ROUTER_SKILL, "SKILL.md"),
    path.join(home, "skills", CONTENT_ROUTER_SKILL, "SKILL.md"),
    path.join(projectRoot, "integrations", "hermes", "skills", "research", CONTENT_ROUTER_SKILL, "SKILL.md"),
  ];
  for (const file of files) {
    try {
      const goals = parseDefaultGoals(fs.readFileSync(file, "utf8"));
      if (goals.length) return goals;
    } catch {
      /* next file */
    }
  }
  return [...BUILT_IN_SOCIAL_GOALS];
}

/** The source id of a goal that is not a default goal: `goal:` and the goal kind. */
export function customGoalId(kind: string): string {
  return `goal:${goalKey(kind)}`;
}

/**
 * The goal of a source id, at read time (design D5): a default goal id (also the five old ids of
 * the social sources, `reddit`, `x`, `youtube`, `tiktok`, `instagram`), or `goal:<kind>`. Null for
 * a base source (`web`, `papers`, `company`) or an unknown id.
 */
export function goalOfSource(id: string, defaults: readonly GoalKind[] = BUILT_IN_SOCIAL_GOALS): GoalKind | null {
  const known = defaults.find((g) => g.id === id) ?? BUILT_IN_SOCIAL_GOALS.find((g) => g.id === id);
  if (known) return known;
  if (id.startsWith("goal:") && id.length > 5) {
    const kind = id.slice(5).trim();
    return { id, kind, label: kind.charAt(0).toUpperCase() + kind.slice(1) };
  }
  return null;
}

export type GoalSearch = {
  /** The first day of the period, `YYYY-MM-DD`. Items before it are left out. */
  sinceDay: string;
  /** Today, `YYYY-MM-DD`. Default: the UTC day of now. */
  today?: string;
  deadline: number;
};

export type GoalDeps = {
  /** The client of the content router, or null with the reason. */
  client: RouterClient | null;
  unavailable?: RouterUnavailable;
  llm?: LearnLlm;
  /** The hints that the companion passed, for the route model call. */
  hints?: readonly string[];
  /** HERMES_HOME of the box skill `joshu-content-cache`. Tests pass a temporary folder. */
  home?: string;
  now?: () => Date;
};

/** A post or other item of a goal, before it gets its identifier in a report. */
export type GoalItem = {
  title: string;
  summary: string;
  url: string;
  source: string;
  sourceLabel: string;
  publishedAt?: string;
  engagement: Record<string, number>;
};

export type GoalResult = { items: GoalItem[]; state: SourceState; endpoint?: string };

/** Engine status of a goal whose recipe failed its check twice (risk 2 of design.md). */
export const COULD_NOT_BE_READ = "could not be read";
/** Engine status of a goal with no working provider endpoint, also while a failed entry blocks a new learning. */
export const NO_ROUTE = "no route";
/** The most `goal:` sources (goals that are not default goals) of one report or one run. */
export const MAX_GOAL_SOURCES = 5;
/** Engine status of a `goal:` source over the limit. */
export const TOO_MANY_GOALS = `more than ${MAX_GOAL_SOURCES} goal sources`;
/** Failures that do not say anything about the provider endpoint, so the box does not remember them. */
const PASSING_FAULTS: ReadonlySet<string> = new Set<RouterFailure>(["usage wallet empty", "rate limited", "unauthorized", "no channel available"]);

/** Failures that count against a cached route. An empty usage wallet or a rate limit is not the fault of the provider endpoint. */
const ROUTE_FAULTS: ReadonlySet<string> = new Set<RouterFailure | typeof COULD_NOT_BE_READ>(["error", "unknown endpoint", "provider error", "timed out", COULD_NOT_BE_READ]);

/** One box sends at most four router calls at once. */
export const ROUTER_CONCURRENCY = 4;
const routerSlots = limiter(ROUTER_CONCURRENCY);

function state(goal: ContentGoal, name: SourceState["state"], engineStatus: string): SourceState {
  return { name: goal.id, label: goal.label, state: name, engineStatus };
}

function asItem(goal: ContentGoal, item: RecipeItem): GoalItem {
  const summary = [item.author, item.text].filter(Boolean).join(": ").slice(0, 300);
  return {
    title: item.title,
    summary,
    url: item.url,
    source: goal.id,
    sourceLabel: goal.label,
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    engagement: item.metrics,
  };
}

function noteFailure(goal: ContentGoal, kind: string, home: string, fresh: boolean): void {
  if (fresh || !ROUTE_FAULTS.has(kind)) return;
  updateRoute(
    goal.kind,
    (cur) => {
      if (!cur) return cur;
      const failures = cur.failures + 1;
      // Three failures in a row: drop the route, so the next report learns it again.
      return failures >= MAX_ROUTE_FAILURES ? undefined : { ...cur, failures };
    },
    home,
  );
}

/**
 * A cached route that the box can use, or null. The route cache is a file in a skill folder that
 * the companion can edit, so the box checks each value again before a paid call.
 */
export function usableRoute(entry: RouteEntry | undefined): RouteEntry | null {
  if (!entry || entry.retryAfter) return null;
  if (typeof entry.endpoint !== "string" || !ENDPOINT_ID_PATTERN.test(entry.endpoint) || entry.endpoint.startsWith("treg.")) return null;
  if (typeof entry.queryInput !== "string" || !INPUT_NAME_PATTERN.test(entry.queryInput)) return null;
  return { ...entry, fixedInputs: cleanFixedInputs(entry.fixedInputs), failures: Number(entry.failures) || 0 };
}

/** Remember that a goal kind has no working provider endpoint, so the next report neither learns nor pays again for a while. */
function rememberNoRoute(goal: ContentGoal, endpoint: string, reason: string, now: Date, home: string): void {
  const retryAfter = new Date(now.getTime() + NO_ROUTE_RETRY_DAYS * 86_400_000).toISOString();
  updateRoute(
    goal.kind,
    () => ({ endpoint, queryInput: "", fixedInputs: {}, ...(goal.prefer ? { prefer: goal.prefer } : {}), origin: "learned", learnedAt: now.toISOString(), failures: 0, retryAfter, reason }),
    home,
  );
}

/** Keep the default goals and the first five `goal:` sources; the others get a source row that says why. */
export function limitGoalSources<T extends { id: string }>(goals: readonly T[]): { kept: T[]; dropped: T[] } {
  let custom = 0;
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const g of goals) {
    if (g.id.startsWith("goal:") && ++custom > MAX_GOAL_SOURCES) dropped.push(g);
    else kept.push(g);
  }
  return { kept, dropped };
}

/** Apply the cached recipe, or learn one (at most one model call for each call of the goal). */
async function readItems(
  goal: ContentGoal,
  endpoint: string,
  body: unknown,
  today: string,
  deadline: number,
  deps: GoalDeps,
  home: string,
): Promise<{ items: RecipeItem[]; dated: boolean } | { unreadable: string }> {
  // The shape cache is a file in a skill folder, so the cached recipe is checked again.
  const cached: ShapeRecipe | undefined = checkRecipe(readShapes(home).shapes[endpoint]) ?? undefined;
  let problem = cached ? "" : "no recipe";
  if (cached) {
    const items = applyRecipe(body, cached);
    const check = checkItems(items, today, cached);
    if (check.ok) return { items, dated: Boolean(cached.publishedAt) };
    // An empty reply is not a failed recipe.
    if (!items.length && longestList(body) === 0) return { items: [], dated: true };
    problem = check.reason;
  } else if (longestList(body) === 0) {
    return { items: [], dated: true };
  }
  let recipe: ShapeRecipe;
  try {
    recipe = await learnRecipe(endpoint, goal.kind, body, deadline, deps.llm, cached ? problem : undefined);
  } catch (err) {
    return { unreadable: `recipe model call failed: ${(err as Error).message}` };
  }
  const items = applyRecipe(body, recipe);
  const check = checkItems(items, today, recipe);
  if (!check.ok) return { unreadable: check.reason };
  saveShape(endpoint, recipe, (deps.now ?? (() => new Date()))().toISOString(), home);
  return { items, dated: Boolean(recipe.publishedAt) };
}

/** Resolve one content goal. Never throws. */
export async function resolveGoal(goal: ContentGoal, search: GoalSearch, deps: GoalDeps): Promise<GoalResult> {
  if (!deps.client) return { items: [], state: state(goal, "could not be reached", deps.unavailable ?? "content router off") };
  const client = deps.client;
  const home = deps.home ?? hermesHome();
  const now = (deps.now ?? (() => new Date()))();
  const today = search.today ?? now.toISOString().slice(0, 10);

  let cached: RouteEntry | undefined;
  try {
    cached = readRoutes(home).routes[goalKey(goal.kind)];
  } catch {
    cached = undefined;
  }
  // A failed entry blocks a new learning until its time, unless a hint names another provider.
  if (cached?.retryAfter && cached.retryAfter > now.toISOString() && (cached.prefer ?? "") === (goal.prefer ?? "")) {
    return { items: [], state: state(goal, "could not be reached", NO_ROUTE) };
  }
  let route: RouteEntry | null = usableRoute(cached);
  // A hint that names another provider makes the box look again (spec content-goals, "Hints").
  if (route && goal.prefer && !matchesPrefer(route.endpoint, goal.prefer)) route = null;
  let fresh = false;
  if (!route) {
    try {
      const learned = await learnRoute(client, goal, deps.hints ?? [], search.deadline, deps.llm);
      route = { ...learned, ...(goal.prefer ? { prefer: goal.prefer } : {}), origin: "learned", learnedAt: now.toISOString(), failures: 0 };
      fresh = true;
    } catch (err) {
      const kind = err instanceof RouterError ? err.kind : NO_ROUTE;
      if (!PASSING_FAULTS.has(kind)) rememberNoRoute(goal, "", `${kind}: ${(err as Error).message}`.slice(0, 200), now, home);
      return { items: [], state: state(goal, "could not be reached", kind) };
    }
  }

  const params = { ...route.fixedInputs, [route.queryInput]: goal.query };
  let body: unknown;
  try {
    body = (await routerSlots(() => client.call({ endpoint: route!.endpoint, params }, search.deadline))).body;
  } catch (err) {
    const kind = err instanceof RouterError ? err.kind : "error";
    noteFailure(goal, kind, home, fresh);
    if (fresh && !PASSING_FAULTS.has(kind)) rememberNoRoute(goal, route.endpoint, kind, now, home);
    return { items: [], state: state(goal, "could not be reached", kind), endpoint: route.endpoint };
  }

  const read = await readItems(goal, route.endpoint, body, today, search.deadline, deps, home);
  if ("unreadable" in read) {
    // The state shows only "could not be read"; the reason goes to the log for diagnosis.
    console.warn(`[content-router] goal ${goal.kind}: ${route.endpoint} could not be read: ${read.unreadable}`);
    noteFailure(goal, COULD_NOT_BE_READ, home, fresh);
    if (fresh) rememberNoRoute(goal, route.endpoint, COULD_NOT_BE_READ, now, home);
    return { items: [], state: state(goal, "could not be reached", COULD_NOT_BE_READ), endpoint: route.endpoint };
  }
  if (read.items.length) {
    const ok = route;
    updateRoute(goal.kind, () => ({ ...ok, failures: 0, lastSuccessAt: now.toISOString() }), home);
  } else if (fresh) {
    // A new route whose first reply gives no items is remembered as failed, so the next report
    // does not learn and pay again for the same goal kind.
    rememberNoRoute(goal, route.endpoint, "returned no items", now, home);
  }
  // When the provider endpoint has dates, an item with no date cannot be placed in the period, so
  // it is left out. Items of a provider endpoint with no dates (for example markets) all count.
  const items = read.items
    .filter((i) => i.title && (!read.dated || (i.publishedAt && i.publishedAt >= search.sinceDay)))
    .map((i) => asItem(goal, i));
  return { items, state: state(goal, items.length ? "returned items" : "returned no items", "ok"), endpoint: route.endpoint };
}

/** Resolve goals in parallel. Items keep the order of the goals and of each reply. */
export async function resolveGoals(goals: readonly ContentGoal[], search: GoalSearch, deps: GoalDeps): Promise<{ items: GoalItem[]; sources: SourceState[] }> {
  const { kept, dropped } = limitGoalSources(goals);
  const results = await Promise.all(kept.map((g) => resolveGoal(g, search, deps)));
  return {
    items: results.flatMap((r) => r.items),
    sources: [...results.map((r) => r.state), ...dropped.map((g) => state(g, "could not be reached", TOO_MANY_GOALS))],
  };
}
