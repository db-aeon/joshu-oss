/**
 * The social sources of Research reports and report updates (change content-router, design
 * decision D6). Each social source is a content goal that goes through the content router: the
 * default social goals of skill `joshu-content-router` (Reddit posts, YouTube videos, TikTok
 * videos, Instagram reels, X posts) and the extra goals of hints. This module names no provider
 * endpoint and no provider path. A failed goal gives its source the state "could not be reached"
 * and never fails the caller (spec `content-goals`).
 */

import { boxRouterClient, type RouterClient, type RouterUnavailable } from "../../contentRouter/client.js";
import {
  defaultSocialGoals,
  goalOfSource,
  resolveGoals,
  type ContentGoal,
  type GoalDeps,
  type GoalKind,
} from "../../contentRouter/goals.js";
import type { LearnLlm } from "../../contentRouter/learn.js";
import type { CollectedItem, SourceState } from "../types.js";

/** A post before it gets its identifier in a Research report or a report update. */
export type SocialPost = Omit<CollectedItem, "id" | "relevance" | "theme">;

/** A source id of a social source: a default goal id (`reddit`) or `goal:<kind>`. */
export type SocialSource = string;

/**
 * A goal of a report: a goal kind, the provider that a hint names, and its own query when it has
 * one (an extra goal of a hint). Without a query, the goal uses the query of the search.
 */
export type GoalRequest = GoalKind & { prefer?: string; query?: string };

export type SocialSearch = {
  /** A short keyword query. */
  query: string;
  /** The first day of the period, `YYYY-MM-DD`. Posts before it are left out. */
  sinceDay: string;
  /** The number of days of the period. */
  days: number;
  deadline: number;
};

export type SocialDeps = {
  /** The content router client; null means the box has none. Default: the client of this box. */
  client?: RouterClient | null;
  unavailable?: RouterUnavailable;
  llm?: LearnLlm;
  hints?: readonly string[];
  /** HERMES_HOME of the box skill `joshu-content-cache`. Tests pass a temporary folder. */
  home?: string;
  projectRoot?: string;
  now?: () => Date;
};

/** The default social goals of this box (skill `joshu-content-router`). */
export function socialGoalKinds(deps: SocialDeps = {}): GoalKind[] {
  return defaultSocialGoals(deps.projectRoot ?? process.cwd(), deps.home);
}

/** The ids of the default social goals, when the box can call the content router; else none. */
export function availableSocialSources(deps: SocialDeps = {}): SocialSource[] {
  const client = deps.client === undefined ? boxRouterClient(deps.projectRoot ?? process.cwd()).client : deps.client;
  return client ? socialGoalKinds(deps).map((g) => g.id) : [];
}

/** The goal requests of source ids: default goal ids and `goal:<kind>` ids; base sources are left out. */
export function goalsOfSources(ids: readonly string[], deps: SocialDeps = {}): GoalRequest[] {
  const defaults = socialGoalKinds(deps);
  const out: GoalRequest[] = [];
  for (const id of ids) {
    const goal = goalOfSource(id, defaults);
    if (goal && !out.some((g) => g.id === goal.id)) out.push(goal);
  }
  return out;
}

function goalDeps(deps: SocialDeps): GoalDeps {
  if (deps.client !== undefined) {
    return { client: deps.client, ...(deps.unavailable ? { unavailable: deps.unavailable } : {}), llm: deps.llm, hints: deps.hints, home: deps.home, now: deps.now };
  }
  const box = boxRouterClient(deps.projectRoot ?? process.cwd());
  return {
    client: box.client,
    ...(box.client ? {} : { unavailable: box.reason }),
    llm: deps.llm,
    hints: deps.hints,
    home: deps.home,
    now: deps.now,
  };
}

/**
 * Search the goals in parallel, each with the query of the search. Posts keep the order of the
 * goals and of each reply. One source state for each goal.
 */
export async function searchSocial(
  goals: readonly GoalRequest[],
  search: SocialSearch,
  deps: SocialDeps = {},
): Promise<{ posts: SocialPost[]; sources: SourceState[] }> {
  const full: ContentGoal[] = goals.map((g) => ({ ...g, query: g.query || search.query }));
  const found = await resolveGoals(full, { sinceDay: search.sinceDay, deadline: search.deadline }, goalDeps(deps));
  const posts: SocialPost[] = found.items;
  return { posts, sources: found.sources };
}
