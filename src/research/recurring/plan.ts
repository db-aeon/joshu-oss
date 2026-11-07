/**
 * The lane plans and the Auto picks of a recurring report (design decision D2): one model call with
 * no-training routing for all new lanes, with only the sources that the box can use. The box saves
 * each lane plan in `setup.json` and uses it on every run, so two runs search the same way. Each
 * lane plan also says what its topic means and what it is not (D14), and has the search terms of
 * the lane (change research-keyword-expansion). The call follows the notes of the owner.
 */

import { exaClient } from "../pipeline/exa.js";
import { composioSearchClient } from "../pipeline/composioSearch.js";
import { asString, asStringArray, callJson, type JsonCallOpts } from "../pipeline/llm.js";
import { checkExtraGoals, checkTerms, cleanHints, termRules } from "../pipeline/plan.js";
import { availableSocialSources, type SocialDeps } from "../social/sources.js";
import type { PlanCompany } from "../types.js";
import { isResearchSourceId, RESEARCH_SOURCE_IDS, researchSourceLabel, type Lane, type LanePlan, type ResearchSourceId } from "./types.js";

export type PlanLlm = Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot">;

/** The sources that this box can use: a source with no key or no relay is left out. */
export function availableSources(projectRoot: string, socialDeps: SocialDeps = {}): ResearchSourceId[] {
  const out: ResearchSourceId[] = [];
  if (exaClient(projectRoot)) out.push("web");
  if (composioSearchClient(projectRoot)) out.push("papers", "company");
  out.push(...availableSocialSources(socialDeps));
  return out;
}

/**
 * A list of sources with Web and news first and no unknown or repeated source. The sources of the
 * Research app keep their order; `goal:` sources come after them.
 */
export function withWebAndNews(sources: readonly string[]): ResearchSourceId[] {
  const known = sources.filter((s) => isResearchSourceId(s) && s !== "web");
  const goals = known.filter((s, i) => !RESEARCH_SOURCE_IDS.includes(s) && known.indexOf(s) === i);
  return ["web", ...RESEARCH_SOURCE_IDS.filter((s) => known.includes(s)), ...goals];
}

/** The sources that a lane uses on a run. */
export function laneSources(lane: Lane, sources: "auto" | ResearchSourceId[]): ResearchSourceId[] {
  if (sources !== "auto") return withWebAndNews(sources);
  return withWebAndNews(lane.plan?.picks ?? []);
}

const ABOUT_RULES = `- about: one sentence on what the topic means, so that a reader can tell it apart from things with a similar name. For a company, say what it does, and its website when you know it.
- not_about: up to four companies, products, or people with the same or a similar name that the topic is not about, each with a few words that tell it apart. [] when you know of none.
${termRules("the topic, its hints, or the notes for this topic")}`;

const SYSTEM = `You plan the searches of a recurring news report for a busy professional. The report follows each topic and reports only what is new.
Return JSON only: {"lanes": [{"topic": string, "picks": [string], "reason": string, "web_queries": [string, string], "news_query": string, "social_query": string, "scholar_query": string, "company": {"name": string, "ticker": string, "exchange": string} | null, "about": string, "not_about": [string], "named_terms": [string], "expanded_terms": [string], "extra_goals": [{"goal": string, "query": string, "prefer": string}]}]}
Rules:
- One entry in "lanes" for each topic, in the same order.
- picks: when "Pick sources" is yes, "web" and the two to four other sources from "Sources you can use" where this topic gets the most regular coverage. Pick few: each extra source costs time and money on every run.
  - "papers" only when peer-reviewed studies are where news on the topic comes from (science, medicine, engineering research). Not for business, markets, deals, policy, or products.
  - "company" only when the topic is one public company.
  - "x" and "reddit" for topics that professionals or enthusiasts discuss online.
  - "youtube" for products, technology demos, and explainers.
  - "tiktok" and "instagram" only for consumer, lifestyle, or visual topics.
  When "Pick sources" is no, return ["web"].
- reason: one plain sentence for the owner on why these sources fit the topic. Empty when "Pick sources" is no.
- web_queries: two web search queries for news and analysis on the topic. Short keywords, no dates.
- news_query: one Google News query. Short keywords, no dates.
- social_query: two to four keywords that people use on Reddit, X, YouTube, TikTok, and Instagram for the topic.
- scholar_query: a Google Scholar query when peer-reviewed studies cover the topic, else an empty string.
- company: the company when the topic is about one public company, with its stock ticker and its exchange as Google Finance writes them. null otherwise.
${ABOUT_RULES}
- Use the hints of a topic, when it has them, as search words.
- extra_goals: only when "Source hints" are given. For each source hint that fits the topic and asks for a kind of source that is not in "Sources you can use", one goal: "goal" is the kind of source in a few words (for example "prediction market odds"), "query" is two to four keywords for that source, and "prefer" is the provider that the hint names (for example "Polymarket"), or an empty string. At most three. [] when no source hint fits.
- When the owner gave notes, follow what they say about the topics: what a topic means, what it is not, and what to look at.`;

function checkCompany(raw: unknown): PlanCompany | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const name = asString(c.name);
  const ticker = asString(c.ticker).toUpperCase();
  const exchange = asString(c.exchange).toUpperCase();
  return name && /^[A-Z0-9.\-]{1,10}$/.test(ticker) && exchange ? { name, ticker, exchange } : undefined;
}

/** A plan without a model, so that a lane still runs when the plan call fails. */
export function fallbackLanePlan(lane: Pick<Lane, "topic" | "hints">, available: ResearchSourceId[], at: string): LanePlan {
  const hint = lane.hints?.[0] ?? lane.topic;
  return {
    picks: withWebAndNews(available.filter((s) => ["reddit", "x", "youtube"].includes(s))),
    reason: "These sources cover most topics.",
    webQueries: [lane.topic, `${hint} news`],
    newsQuery: lane.topic,
    socialQuery: hint,
    scholarQuery: "",
    madeAt: at,
  };
}

/**
 * Plan the lanes in `lanes` with one model call. Picks are only from `available`. When the call
 * fails, each lane gets the plan of `fallbackLanePlan`.
 */
export async function planLanes(
  lanes: Pick<Lane, "topic" | "hints">[],
  opts: { available: ResearchSourceId[]; pickSources: boolean; deadline: number; now: Date; llm?: PlanLlm; notes?: string; hints?: readonly string[] },
): Promise<LanePlan[]> {
  if (!lanes.length) return [];
  const at = opts.now.toISOString();
  const allowed = opts.available.includes("web") ? opts.available : (["web", ...opts.available] as ResearchSourceId[]);
  const hints = cleanHints(opts.hints);
  const user = [
    `Pick sources: ${opts.pickSources ? "yes" : "no"}`,
    `Sources you can use: ${allowed.map((s) => `${s} (${researchSourceLabel(s)})`).join(", ")}`,
    ...(opts.notes?.trim() ? [`Notes of the owner: ${opts.notes.trim()}`] : []),
    ...(hints.length ? [`Source hints:\n${hints.map((h) => `- ${h}`).join("\n")}`] : []),
    "Topics:",
    ...lanes.map((l, i) => `${i + 1}. ${l.topic}${l.hints?.length ? ` (hints: ${l.hints.join("; ")})` : ""}`),
  ].join("\n");
  try {
    const { value } = await callJson<LanePlan[]>({
      ...opts.llm,
      step: "plan",
      system: SYSTEM,
      user,
      deadline: opts.deadline,
      maxTokens: 400 + 450 * lanes.length,
      check: (raw) => {
        const list = raw && typeof raw === "object" ? (raw as { lanes?: unknown }).lanes : undefined;
        if (!Array.isArray(list) || list.length !== lanes.length) return null;
        return list.map((entry, i): LanePlan => {
          const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
          const fallback = fallbackLanePlan(lanes[i]!, allowed, at);
          const webQueries = asStringArray(e.web_queries).slice(0, 2);
          const company = checkCompany(e.company);
          const scholarQuery = asString(e.scholar_query);
          const about = asString(e.about);
          const notAbout = asStringArray(e.not_about).slice(0, 4);
          const extraGoals = hints.length ? checkExtraGoals(e.extra_goals) : [];
          // Company data needs one company, and Research papers need a Google Scholar query.
          const usable = (id: string) => (allowed as string[]).includes(id) && (id !== "company" || Boolean(company)) && (id !== "papers" || Boolean(scholarQuery));
          const picks = opts.pickSources ? withWebAndNews(asStringArray(e.picks).filter(usable)) : ["web" as const];
          return {
            picks,
            reason: opts.pickSources ? asString(e.reason) || fallback.reason : "",
            webQueries: webQueries.length ? webQueries : fallback.webQueries,
            newsQuery: asString(e.news_query) || fallback.newsQuery,
            socialQuery: asString(e.social_query) || fallback.socialQuery,
            scholarQuery,
            ...(company ? { company } : {}),
            ...(about ? { about } : {}),
            ...(notAbout.length ? { notAbout } : {}),
            ...checkTerms(e),
            ...(extraGoals.length ? { extraGoals } : {}),
            madeAt: at,
          };
        });
      },
    });
    return value;
  } catch {
    return lanes.map((l) => {
      const plan = fallbackLanePlan(l, allowed, at);
      return opts.pickSources ? plan : { ...plan, picks: ["web"], reason: "" };
    });
  }
}

const MEANING_SYSTEM = `You say what the topics of a recurring news report mean, so that the report leaves out things with a similar name, and which terms each topic searches by name.
Return JSON only: {"lanes": [{"topic": string, "about": string, "not_about": [string], "named_terms": [string], "expanded_terms": [string]}]}
Rules:
- One entry in "lanes" for each topic, in the same order.
${ABOUT_RULES}
- When the owner gave notes, follow what they say about the topics: what a topic means and what it is not.`;

/** What a lane topic means and what it is not (D14), and its search terms. */
export type LaneMeaning = Pick<LanePlan, "about" | "notAbout" | "namedTerms" | "expandedTerms">;

/**
 * What the topics of `lanes` mean and their search terms, with one model call, for a lane plan from
 * before D14 that has no `about`, or from before change research-keyword-expansion that has no
 * search terms. The call returns only these fields, so the queries and the sources of the lane plan
 * stay the same. A lane gets `{}` when the call fails, and no `about` when the call gives it none.
 */
export async function describeLanes(lanes: Pick<Lane, "topic" | "hints">[], opts: { deadline: number; llm?: PlanLlm; notes?: string }): Promise<LaneMeaning[]> {
  if (!lanes.length) return [];
  const user = [
    ...(opts.notes?.trim() ? [`Notes of the owner: ${opts.notes.trim()}`] : []),
    "Topics:",
    ...lanes.map((l, i) => `${i + 1}. ${l.topic}${l.hints?.length ? ` (hints: ${l.hints.join("; ")})` : ""}`),
  ].join("\n");
  try {
    const { value } = await callJson<LaneMeaning[]>({
      ...opts.llm,
      step: "plan",
      system: MEANING_SYSTEM,
      user,
      deadline: opts.deadline,
      maxTokens: 200 + 300 * lanes.length,
      check: (raw) => {
        const list = raw && typeof raw === "object" ? (raw as { lanes?: unknown }).lanes : undefined;
        if (!Array.isArray(list) || list.length !== lanes.length) return null;
        return list.map((entry): LaneMeaning => {
          const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
          const about = asString(e.about);
          const notAbout = asStringArray(e.not_about).slice(0, 4);
          return { ...(about ? { about, ...(notAbout.length ? { notAbout } : {}) } : {}), ...checkTerms(e) };
        });
      },
    });
    return value;
  } catch {
    return lanes.map(() => ({}));
  }
}
