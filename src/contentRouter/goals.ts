/**
 * The content goals client (change content-router, design decisions D2 and D5). `resolveGoal`
 * turns a content goal, for example "YouTube videos: humanoid robots", into one router call and
 * items:
 * 1. Look up the goal kind in the route cache.
 * 2. On a miss, search the router catalog, pick a provider endpoint with one model call, and keep
 *    the choice when the call returns items.
 * 3. Call the provider endpoint. When the third fault in a row removes a cached route, learn one
 *    new route without the provider endpoint that failed, and call it (change route-cache-no-wait).
 * 4. Look up the shape recipe of the provider endpoint.
 * 5. On a miss, or when the recipe fails its check on a reply with a list, learn the recipe with
 *    one model call, and keep it. A recipe that fails again gives the state "could not be read".
 * 6. Return the items.
 * A goal never throws: a failure gives its source the state "could not be reached" with the reason.
 * The route cache is a plain cache: it holds only routes that the box can call, and a goal kind
 * with no usable entry is learned at each use, with no wait.
 */

import fs from "node:fs";
import path from "node:path";
import { limiter } from "../research/pipeline/llm.js";
import { hermesHome } from "../proactive/boards.js";
import type { SourceState } from "../research/types.js";
import { RouterError, type RouterClient, type RouterFailure, type RouterUnavailable } from "./client.js";
import { cleanFixedInputs, ENDPOINT_ID_PATTERN, INPUT_NAME_PATTERN, learnRecipe, learnRoute, matchesPrefer, type LearnLlm } from "./learn.js";
import { applyRecipe, checkItems, checkRecipe, longestList, type RecipeItem, type ShapeRecipe } from "./recipe.js";
import { goalKey, MAX_ROUTE_FAILURES, readRoutes, ROUTE_FAULT_GAP_MS, readShapes, saveShape, updateRoute, type RouteEntry } from "./store.js";

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
 * a source that is not a social goal (`web`, `papers`, `company`) or an unknown id.
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
/** Engine status of a goal for which the box could not learn a route: the router catalog has no provider endpoint, or the model gave no valid answer. */
export const NO_ROUTE = "no route";
/** The most `goal:` sources (goals that are not default goals) of one report or one run. */
export const MAX_GOAL_SOURCES = 5;
/** Engine status of a `goal:` source over the limit. */
export const TOO_MANY_GOALS = `more than ${MAX_GOAL_SOURCES} goal sources`;
/**
 * Failures that count against a cached route. An empty usage wallet, a rate limit, an unauthorized
 * answer, or no channel is not the fault of the provider endpoint.
 */
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

/**
 * Count a fault against the cached route of a goal kind. The third fault in a row removes the
 * entry. Returns true when the route cache has no entry for the goal kind after the count. A fault
 * does not count against an entry of another provider endpoint, which another report wrote in
 * the meantime, and a fault within `ROUTE_FAULT_GAP_MS` of the last counted fault does not count again.
 */
function noteFault(goal: ContentGoal, endpoint: string, now: Date, home: string): boolean {
  let gone = false;
  updateRoute(
    goal.kind,
    (cur) => {
      if (!cur) {
        gone = true;
        return cur;
      }
      if (cur.endpoint !== endpoint) return cur;
      const last = Date.parse(cur.lastFailureAt ?? "");
      if (Number.isFinite(last) && Math.abs(now.getTime() - last) < ROUTE_FAULT_GAP_MS) return cur;
      const failures = (Number(cur.failures) || 0) + 1;
      gone = failures >= MAX_ROUTE_FAILURES;
      return gone ? undefined : { ...cur, failures, lastFailureAt: now.toISOString() };
    },
    home,
  );
  return gone;
}

/**
 * A cached route that the box can use, or null. The route cache is a file in a skill folder that
 * the companion can edit, so the box checks each value again before a paid call.
 */
export function usableRoute(entry: RouteEntry | undefined): RouteEntry | null {
  if (!entry) return null;
  if (typeof entry.endpoint !== "string" || !ENDPOINT_ID_PATTERN.test(entry.endpoint) || entry.endpoint.startsWith("treg.")) return null;
  if (typeof entry.queryInput !== "string" || !INPUT_NAME_PATTERN.test(entry.queryInput)) return null;
  return { ...entry, fixedInputs: cleanFixedInputs(entry.fixedInputs), failures: Number(entry.failures) || 0 };
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

type GoalRead = { items: RecipeItem[]; dated: boolean };

/** Call the provider endpoint of a route and read its items. A failure comes back as `fault`, never as a throw. */
async function callRoute(
  goal: ContentGoal,
  route: RouteEntry,
  client: RouterClient,
  search: GoalSearch,
  today: string,
  deps: GoalDeps,
  home: string,
): Promise<GoalRead | { fault: string }> {
  const params = { ...route.fixedInputs, [route.queryInput]: goal.query };
  let body: unknown;
  try {
    body = (await routerSlots(() => client.call({ endpoint: route.endpoint, params }, search.deadline))).body;
  } catch (err) {
    return { fault: err instanceof RouterError ? err.kind : "error" };
  }
  const read = await readItems(goal, route.endpoint, body, today, search.deadline, deps, home);
  if ("unreadable" in read) {
    // The state shows only "could not be read"; the reason goes to the log for diagnosis.
    console.warn(`[content-router] goal ${goal.kind}: ${route.endpoint} could not be read: ${read.unreadable}`);
    return { fault: COULD_NOT_BE_READ };
  }
  return read;
}

/** Resolve one content goal. Never throws. Learns at most one route. */
export async function resolveGoal(goal: ContentGoal, search: GoalSearch, deps: GoalDeps): Promise<GoalResult> {
  if (!deps.client) return { items: [], state: state(goal, "could not be reached", deps.unavailable ?? "content router off") };
  const client = deps.client;
  const home = deps.home ?? hermesHome();
  const now = (deps.now ?? (() => new Date()))();
  const today = search.today ?? now.toISOString().slice(0, 10);
  const unreachable = (fault: string, endpoint?: string): GoalResult => ({
    items: [],
    state: state(goal, "could not be reached", fault),
    ...(endpoint ? { endpoint } : {}),
  });

  /** Learn a route with one model call. `without` is the provider endpoint that just failed. */
  const learn = async (without?: string): Promise<RouteEntry | { fault: string }> => {
    try {
      const learned = await learnRoute(client, goal, deps.hints ?? [], search.deadline, deps.llm, without);
      return { ...learned, ...(goal.prefer ? { prefer: goal.prefer } : {}), origin: "learned", learnedAt: now.toISOString(), failures: 0 };
    } catch (err) {
      return { fault: err instanceof RouterError ? err.kind : NO_ROUTE };
    }
  };

  let cached: RouteEntry | undefined;
  try {
    cached = readRoutes(home).routes[goalKey(goal.kind)];
  } catch {
    cached = undefined;
  }
  let route: RouteEntry | null = usableRoute(cached);
  // A hint that names another provider makes the box look again (spec content-goals, "Hints").
  if (route && goal.prefer && !matchesPrefer(route.endpoint, goal.prefer)) route = null;
  // True when this call learned `route`. The box keeps such a route only when it returns items.
  let fresh = false;
  if (!route) {
    const learned = await learn();
    if ("fault" in learned) return unreachable(learned.fault);
    route = learned;
    fresh = true;
  }

  let read = await callRoute(goal, route, client, search, today, deps, home);
  if ("fault" in read && !fresh && ROUTE_FAULTS.has(read.fault) && noteFault(goal, route.endpoint, now, home)) {
    // The third fault in a row removed the cached route. Learn one new route for this report,
    // without the provider endpoint that failed. When there is none, the goal keeps the fault.
    const learned = await learn(route.endpoint);
    if ("fault" in learned) return unreachable(read.fault, route.endpoint);
    route = learned;
    fresh = true;
    read = await callRoute(goal, route, client, search, today, deps, home);
  }
  if ("fault" in read) return unreachable(read.fault, route.endpoint);

  if (read.items.length) {
    const { lastFailureAt: _counted, ...ok } = route;
    updateRoute(goal.kind, () => ({ ...ok, failures: 0, lastSuccessAt: now.toISOString() }), home);
  }
  // When the provider endpoint has dates, an item with no date cannot be placed in the period, so
  // it is left out. Items of a provider endpoint with no dates (for example markets) all count.
  const dated = read.dated;
  const items = read.items
    .filter((i) => i.title && (!dated || (i.publishedAt && i.publishedAt >= search.sinceDay)))
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
