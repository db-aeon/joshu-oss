/**
 * Host-side QueryPlan for last30days — transparent to GUI, jChat, and plugin callers.
 *
 * Upstream SKILL.md expects the hosting model to pass `--plan`; Joshu boxes generate
 * and persist plans here (OpenRouter when configured, heuristics otherwise).
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveBoxSecret } from "../boxSecrets/resolve.js";
import {
  JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL,
  withOpenRouterDataPolicy,
} from "../joshuOpenRouterDefaults.js";
import type { ResearchRequest } from "./runner.js";
import {
  last30daysPlanRuntimeDir,
  last30daysQueryPlansDir,
  migrateLegacyLast30daysState,
} from "./statePaths.js";

/** Coarse topic classes — drives subquery shape and source budget. */
export type TopicKind =
  | "named_entity"
  | "concept"
  | "comparison"
  | "event"
  | "person"
  | "product";

export type QueryPlanSubquery = {
  label: string;
  search_query: string;
  ranking_query: string;
  sources: string[];
  weight: number;
};

export type QueryPlanJson = {
  intent: string;
  freshness_mode: string;
  cluster_mode: string;
  source_weights?: Record<string, number>;
  subqueries: QueryPlanSubquery[];
  notes?: string[];
};

export type StoredQueryPlan = {
  topic: string;
  kind: TopicKind;
  plan: QueryPlanJson;
  /** Engine `--search=` allow-list (excludes noisy lanes for concept/event topics). */
  search?: string;
  subreddits?: string;
  createdAt: number;
};

export type QueryPlanBundle = {
  planPath: string;
  search?: string;
  subreddits?: string;
  kind: TopicKind;
};

const ALLOWED_INTENTS = new Set([
  "factual",
  "product",
  "concept",
  "opinion",
  "how_to",
  "comparison",
  "breaking_news",
  "prediction",
]);

/** Social + web — no jobs (job boards match city+tech noise). */
const CONCEPT_SOURCES = ["grounding", "x", "reddit", "youtube", "hackernews"] as const;
const EVENT_SOURCES = ["grounding", "x", "reddit", "youtube", "hackernews"] as const;
const NAMED_SOURCES = [
  "reddit",
  "x",
  "youtube",
  "hackernews",
  "grounding",
  "polymarket",
  "github",
] as const;
/** Named-entity allow-list for `--search=` — keeps X/YouTube/SC lanes, drops jobs. */
const NAMED_SEARCH_ALLOWLIST = [
  "reddit",
  "x",
  "youtube",
  "hackernews",
  "grounding",
  "polymarket",
  "github",
  "tiktok",
  "instagram",
] as const;

const INTENT_MODIFIERS =
  /\b(use cases?|workflows?|examples?|tutorials?|reviews?|comparison|applications|in practice|production|how i use|how to)\b/i;

const COMPARISON_RE = /\b(vs\.?|versus|compare|difference between)\b/i;

/** Conferences / IRL weeks — not a company brand; year in the topic is schedule metadata. */
const EVENT_RE =
  /\b(tech\s*weeks?|summit|conference|conf\b|festival|fest\b|meetup|hackathon|expo|symposium|unconference|devrel\s*con|sxsw|web\s*summit|ces\b|wwdc|aws\s*reinvent|dreamforce|collision)\b/i;

const HIRING_RE =
  /\b(hiring|jobs?|careers?|recruiting|job board|open roles?|who.?s hiring)\b/i;

/** Trailing schedule year — strip from quoted primary so "LA Tech Week 2026" still matches posts that omit the year. */
const TRAILING_YEAR_RE = /^(.*?)\s+(20\d{2})$/;

const GENERIC_CONCEPT_WORDS = new Set([
  "ai",
  "private",
  "equity",
  "pe",
  "operating",
  "partner",
  "partners",
  "portfolio",
  "company",
  "companies",
  "value",
  "creation",
  "transformation",
  "mid-market",
  "midmarket",
  "middle",
  "market",
  "digital",
  "automation",
  "strategy",
  "technology",
  "artificial",
  "intelligence",
  "the",
  "and",
  "for",
  "into",
  "with",
]);

function plansDir(projectRoot: string): string {
  return last30daysQueryPlansDir(projectRoot);
}

function planKey(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function planStorePath(projectRoot: string, topic: string): string {
  return path.join(plansDir(projectRoot), `${planKey(topic)}.json`);
}

function runtimePlanPath(projectRoot: string): string {
  const dir = last30daysPlanRuntimeDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

/** Drop trailing 20xx year used as schedule metadata (not part of the entity name). */
export function stripTrailingCalendarYear(topic: string): {
  base: string;
  year: string | null;
} {
  const t = topic.trim();
  const m = t.match(TRAILING_YEAR_RE);
  if (!m?.[1]) return { base: t, year: null };
  return { base: m[1].trim(), year: m[2] || null };
}

export function isHiringTopic(topic: string): boolean {
  return HIRING_RE.test(topic);
}

export function isEventTopic(topic: string): boolean {
  return EVENT_RE.test(topic);
}

/** Drop `jobs` unless the owner is explicitly researching hiring. */
export function filterPlanSources(sources: string[], topic: string): string[] {
  const cleaned = sources.map((s) => String(s).trim()).filter(Boolean);
  if (isHiringTopic(topic)) return cleaned;
  return cleaned.filter((s) => s.toLowerCase() !== "jobs");
}

/** Exported for unit tests. */
export function classifyTopic(topic: string): TopicKind {
  const t = topic.trim();
  if (!t) return "concept";
  if (COMPARISON_RE.test(t)) return "comparison";
  if (INTENT_MODIFIERS.test(t)) return "concept";
  // Events before named-entity: "LA Tech Week 2026" is title-case but not a brand.
  if (isEventTopic(t)) return "event";

  const words = t.split(/\s+/).filter(Boolean);
  const lower = words.map((w) => w.toLowerCase());

  // Multi-token proper-noun-ish title (Google DeepMind, SpaceXAI) → named entity.
  const titleCaseRuns = t.match(/(?:[A-Z][a-z0-9]+(?:[-'][A-Za-z0-9]+)?(?:\s+|$)){1,}/g) || [];
  const hasStrongProper = titleCaseRuns.some((run) => run.trim().split(/\s+/).length >= 2);
  const singleBrand =
    words.length === 1 && /^[A-Z]/.test(words[0]!) && !GENERIC_CONCEPT_WORDS.has(lower[0]!);
  const multiCapitalized =
    words.filter((w) => /^[A-Z]/.test(w) && w.length > 1).length >= 2 &&
    words.length <= 6;

  const genericRatio =
    lower.filter((w) => GENERIC_CONCEPT_WORDS.has(w.replace(/[^a-z-]/g, ""))).length /
    Math.max(lower.length, 1);

  if (hasStrongProper || singleBrand || (multiCapitalized && genericRatio < 0.5)) {
    return "named_entity";
  }

  // Long phrase dominated by industry jargon → concept (PE AI ops, etc.).
  if (words.length >= 4 || genericRatio >= 0.35) return "concept";

  if (/\b(pricing|features|review|vs)\b/i.test(t)) return "product";
  return "named_entity";
}

function primaryEntity(topic: string): string {
  const stripped = topic
    .replace(INTENT_MODIFIERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return stripped;
  return words.slice(0, 4).join(" ");
}

function peConceptPlan(topic: string): QueryPlanJson {
  const entity = primaryEntity(topic);
  return {
    intent: "concept",
    freshness_mode: "balanced_recent",
    cluster_mode: "debate",
    subqueries: [
      {
        label: "ops-in-portco",
        search_query: "operating partner AI portfolio company",
        ranking_query: `Are PE operating partners deploying AI inside portfolio company operations (not AI deal sourcing)? Context: ${entity}`,
        sources: [...CONCEPT_SOURCES],
        weight: 1.0,
      },
      {
        label: "value-creation",
        search_query: "value creation AI private equity operations",
        ranking_query: `What are PE value creation teams doing with AI, Copilot, or workflow automation in portcos? Context: ${entity}`,
        sources: [...CONCEPT_SOURCES],
        weight: 0.85,
      },
      {
        label: "mid-market",
        search_query: "middle market private equity AI transformation",
        ranking_query: `How are mid-market PE firms applying AI at portfolio companies? Context: ${entity}`,
        sources: ["grounding", "x", "reddit"],
        weight: 0.7,
      },
      {
        label: "sprint-playbook",
        search_query: "PE 100-day plan AI assessment portco",
        ranking_query: `Are firms selling AI assessments or activation sprints into PE portfolio companies? Context: ${entity}`,
        sources: ["grounding", "x", "youtube"],
        weight: 0.6,
      },
    ],
    notes: ["joshu concept plan: PE/portco AI ops"],
  };
}

function genericConceptPlan(topic: string): QueryPlanJson {
  const core = primaryEntity(topic);
  const kw = core
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC_CONCEPT_WORDS.has(w))
    .slice(0, 4)
    .join(" ");
  const base = kw || core.toLowerCase();
  return {
    intent: "concept",
    freshness_mode: "balanced_recent",
    cluster_mode: "debate",
    subqueries: [
      {
        label: "primary",
        search_query: base,
        ranking_query: `What are practitioners discussing about ${core} in the last 30 days?`,
        sources: [...CONCEPT_SOURCES],
        weight: 1.0,
      },
      {
        label: "workflow",
        search_query: `${base} workflow production`,
        ranking_query: `What real-world workflows or production use of ${core} are people describing?`,
        sources: [...CONCEPT_SOURCES],
        weight: 0.75,
      },
      {
        label: "experience",
        search_query: `${base} experience review`,
        ranking_query: `What hands-on experience reports about ${core} exist recently?`,
        sources: ["reddit", "x", "grounding"],
        weight: 0.65,
      },
    ],
    notes: ["joshu concept plan: generic fan-out"],
  };
}

function quoteMultiWord(entity: string): string {
  return entity.split(/\s+/).length >= 2 ? `"${entity}"` : entity;
}

function namedEntityPlan(topic: string): QueryPlanJson {
  const { base, year } = stripTrailingCalendarYear(topic);
  // Primary quote omits schedule years so social posts that say "Google I/O" still match.
  const quoted = quoteMultiWord(base);
  const sources = filterPlanSources([...NAMED_SOURCES], topic);
  const reactionSources = filterPlanSources(
    ["reddit", "x", "youtube", "hackernews"],
    topic,
  );
  const subqueries: QueryPlanSubquery[] = [
    {
      label: "primary",
      search_query: quoted,
      ranking_query: `What notable discussion about ${base} happened in the last 30 days?`,
      sources,
      weight: 1.0,
    },
    {
      label: "reactions",
      search_query: `${base} reaction review`,
      ranking_query: `What reactions, reviews, or community takes on ${base} appeared recently?`,
      sources: reactionSources,
      weight: 0.7,
    },
  ];
  if (year) {
    subqueries.push({
      label: "year-qualified",
      search_query: `${base} ${year}`,
      ranking_query: `What ${year}-specific news or discussion about ${base} appeared recently?`,
      sources: filterPlanSources(["grounding", "x", "reddit"], topic),
      weight: 0.55,
    });
  }
  return {
    intent: "factual",
    freshness_mode: "balanced_recent",
    cluster_mode: "story",
    subqueries,
    notes: year
      ? ["joshu named-entity plan", "primary quote strips trailing calendar year"]
      : ["joshu named-entity plan"],
  };
}

function eventPlan(topic: string): QueryPlanJson {
  const { base, year } = stripTrailingCalendarYear(topic);
  const quoted = quoteMultiWord(base);
  const sources = filterPlanSources([...EVENT_SOURCES], topic);
  return {
    intent: "breaking_news",
    freshness_mode: "recent",
    cluster_mode: "story",
    subqueries: [
      {
        label: "primary",
        // Never year-lock the primary — most posts omit the year until close to the event.
        search_query: quoted,
        ranking_query: `What are people announcing or discussing about ${base}${year ? ` (${year})` : ""} recently?`,
        sources,
        weight: 1.0,
      },
      {
        label: "hosts-speakers",
        search_query: `${base} host speaker panel`,
        ranking_query: `Which hosts, speakers, panels, or office hours for ${base} are being promoted?`,
        sources: filterPlanSources(["x", "grounding", "reddit", "youtube"], topic),
        weight: 0.85,
      },
      {
        label: "schedule-buzz",
        search_query: year ? `${base} ${year}` : `${base} announcement schedule`,
        ranking_query: `What schedule, partnership, or sponsorship news about ${topic} appeared recently?`,
        sources: filterPlanSources(["grounding", "x", "reddit"], topic),
        weight: 0.7,
      },
    ],
    notes: [
      "joshu event plan",
      "primary quote omits trailing year",
      "jobs excluded via --search allow-list",
    ],
  };
}

function comparisonPlan(topic: string): QueryPlanJson {
  const parts = topic.split(COMPARISON_RE).map((p) => p.trim()).filter(Boolean);
  const a = parts[0] || topic;
  const b = parts[1] || "";
  return {
    intent: "comparison",
    freshness_mode: "balanced_recent",
    cluster_mode: "debate",
    subqueries: [
      {
        label: "head-to-head",
        search_query: `${a} vs ${b}`.trim(),
        ranking_query: `How do people compare ${a} and ${b} recently?`,
        sources: filterPlanSources([...NAMED_SOURCES], topic),
        weight: 1.0,
      },
      ...(b
        ? [
            {
              label: "entity-a",
              search_query: a,
              ranking_query: `Recent evidence about ${a} in the comparison "${topic}"`,
              sources: filterPlanSources(
                ["reddit", "x", "youtube", "hackernews", "grounding"],
                topic,
              ),
              weight: 0.8,
            },
            {
              label: "entity-b",
              search_query: b,
              ranking_query: `Recent evidence about ${b} in the comparison "${topic}"`,
              sources: filterPlanSources(
                ["reddit", "x", "youtube", "hackernews", "grounding"],
                topic,
              ),
              weight: 0.8,
            },
          ]
        : []),
    ],
    notes: ["joshu comparison plan"],
  };
}

function heuristicPlan(topic: string, kind: TopicKind): StoredQueryPlan {
  const t = topic.trim();
  let plan: QueryPlanJson;
  let search: string | undefined;
  let subreddits: string | undefined;

  switch (kind) {
    case "comparison":
      plan = comparisonPlan(t);
      search = "reddit,x,youtube,hackernews,grounding,github";
      break;
    case "concept":
      plan = /\b(private equity|portfolio|operating partner|portco|value creation)\b/i.test(t)
        ? peConceptPlan(t)
        : genericConceptPlan(t);
      search = CONCEPT_SOURCES.join(",");
      subreddits = /\b(private equity|portfolio|operating partner|portco|pe\b)\b/i.test(t)
        ? "privateequity,PrivateEquityLife,consulting"
        : undefined;
      break;
    case "event":
      plan = eventPlan(t);
      // Explicit allow-list — engine --quick defaults otherwise inject `jobs` (city+tech spam).
      search = EVENT_SOURCES.join(",");
      break;
    default:
      plan = namedEntityPlan(t);
      // Always pin sources for named entities so the engine cannot add jobs.
      search = isHiringTopic(t)
        ? [...NAMED_SEARCH_ALLOWLIST, "jobs"].join(",")
        : NAMED_SEARCH_ALLOWLIST.join(",");
      break;
  }

  return { topic: t, kind, plan, search, subreddits, createdAt: Date.now() };
}

/** Heuristic plan only (no OpenRouter) — exported for unit tests. */
export function buildHeuristicQueryPlan(topic: string): StoredQueryPlan {
  const t = topic.trim();
  return heuristicPlan(t, classifyTopic(t));
}

function sanitizeLlmPlan(raw: unknown, topic: string, kind: TopicKind): QueryPlanJson | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const subs = o.subqueries;
  if (!Array.isArray(subs) || subs.length === 0) return null;

  const intent = String(o.intent || "concept");
  const subqueries: QueryPlanSubquery[] = [];
  for (const row of subs.slice(0, 5)) {
    if (!row || typeof row !== "object") continue;
    const sq = row as Record<string, unknown>;
    const search_query = String(sq.search_query || "").trim();
    const ranking_query = String(sq.ranking_query || "").trim();
    if (!search_query || !ranking_query) continue;
    const sourcesRaw = sq.sources;
    const sourcesDefault =
      kind === "event"
        ? [...EVENT_SOURCES]
        : kind === "concept" || kind === "comparison"
          ? [...CONCEPT_SOURCES]
          : [...NAMED_SOURCES];
    const sources = filterPlanSources(
      Array.isArray(sourcesRaw) ? sourcesRaw.map(String).filter(Boolean) : sourcesDefault,
      topic,
    );
    subqueries.push({
      label: String(sq.label || `q${subqueries.length + 1}`).trim() || `q${subqueries.length + 1}`,
      search_query,
      ranking_query,
      sources,
      weight: Math.max(0.05, Number(sq.weight) || 1),
    });
  }
  if (!subqueries.length) return null;

  const defaultIntent =
    kind === "concept" ? "concept" : kind === "event" ? "breaking_news" : "factual";
  return {
    intent: ALLOWED_INTENTS.has(intent) ? intent : defaultIntent,
    freshness_mode: String(
      o.freshness_mode || (kind === "event" ? "recent" : "balanced_recent"),
    ),
    cluster_mode: String(
      o.cluster_mode || (kind === "concept" ? "debate" : "story"),
    ),
    subqueries,
    notes: ["joshu openrouter plan"],
  };
}

async function planViaOpenRouter(topic: string, kind: TopicKind): Promise<QueryPlanJson | null> {
  const apiKey = resolveBoxSecret("OPENROUTER_API_KEY").trim();
  if (!apiKey) return null;

  const model = JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL;
  const sourceHint =
    kind === "concept" || kind === "comparison"
      ? `Use sources from: ${CONCEPT_SOURCES.join(", ")}. Do NOT include jobs, tiktok, instagram, polymarket, stocktwits.`
      : kind === "event"
        ? `Use sources from: ${EVENT_SOURCES.join(", ")}. Do NOT include jobs, tiktok, instagram, polymarket, stocktwits.`
        : `Prefer: ${NAMED_SEARCH_ALLOWLIST.join(", ")}. Do NOT include jobs unless the topic is about hiring.`;

  const system = `You are the query planner for a last-30-days social research engine.
Return JSON only with: intent, freshness_mode, cluster_mode, subqueries[] (label, search_query, ranking_query, sources, weight).

Rules:
- search_query: short keyword phrases; NEVER paste the user's full topic string as the only subquery.
- NEVER include "last 30 days", "recent", month names, or meta words like "news" / "updates" in search_query.
- For concept topics: emit 3-5 paraphrased subqueries with different angles; strip intent modifiers from search_query.
- For named entities / products / people: emit 2-4 subqueries (primary entity + reactions/product angles). Quote multi-word proper nouns. If the topic ends in a calendar year (20xx), omit that year from the primary search_query — year is schedule metadata, not the entity name.
- For event topics (Tech Week, summit, conference, SXSW, …): primary search_query MUST omit any trailing year; fan out hosts/speakers/schedule angles; never add jobs.
- For comparisons: include head-to-head plus per-side subqueries when possible.
- ranking_query: natural-language question for relevance scoring.
- ${sourceHint}`;

  const user = `Topic: ${topic}\nTopic class: ${kind}\nDepth: default`;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://joshu.local",
        "X-Title": "Joshu last30days planner",
      },
      body: JSON.stringify(
        withOpenRouterDataPolicy({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: 2048,
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
      ),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;
    return sanitizeLlmPlan(JSON.parse(content), topic, kind);
  } catch {
    return null;
  }
}

async function buildStoredQueryPlan(topic: string): Promise<StoredQueryPlan> {
  const t = topic.trim();
  const kind = classifyTopic(t);
  // Prefer OpenRouter for every topic class; heuristics are the offline fallback.
  const llm = await planViaOpenRouter(t, kind);
  const base = heuristicPlan(t, kind);
  if (llm) {
    // Re-apply jobs filter even if the model ignored instructions.
    let plan: QueryPlanJson = {
      ...llm,
      subqueries: llm.subqueries.map((sq) => ({
        ...sq,
        sources: filterPlanSources(sq.sources, t),
      })),
    };
    // Year-lock sanitizer for events and named entities (models often quote "… 2026").
    if (kind === "event" || kind === "named_entity" || kind === "product" || kind === "person") {
      plan = hardenPrimaryYearLock(plan, t);
    }
    if (kind === "event" && !base.search) {
      base.search = EVENT_SOURCES.join(",");
    }
    if (
      (kind === "named_entity" || kind === "product" || kind === "person") &&
      !base.search
    ) {
      base.search = isHiringTopic(t)
        ? [...NAMED_SEARCH_ALLOWLIST, "jobs"].join(",")
        : NAMED_SEARCH_ALLOWLIST.join(",");
    }
    base.plan = plan;
    base.plan = {
      ...base.plan,
      notes: [...(base.plan.notes || []), "joshu openrouter plan"],
    };
  }
  return base;
}

/**
 * Primary subquery must not year-lock — models often quote "LA Tech Week 2026"
 * (or "Google I/O 2026") verbatim and starve posts that omit the year.
 */
function hardenPrimaryYearLock(plan: QueryPlanJson, topic: string): QueryPlanJson {
  const { base, year } = stripTrailingCalendarYear(topic);
  if (!year) return plan;
  const quotedBase = quoteMultiWord(base);
  const subqueries = plan.subqueries.map((sq, i) => {
    let search_query = sq.search_query;
    if (i === 0 || sq.label === "primary") {
      if (new RegExp(`\\b${year}\\b`).test(search_query)) {
        search_query = quotedBase;
      }
    }
    return { ...sq, search_query };
  });
  return { ...plan, subqueries };
}

export function loadPersistedQueryPlan(
  projectRoot: string,
  topic: string,
): StoredQueryPlan | null {
  const filePath = planStorePath(projectRoot, topic);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredQueryPlan;
    if (!raw?.plan?.subqueries?.length) return null;
    if (raw.topic?.trim().toLowerCase() !== topic.trim().toLowerCase()) return null;
    return raw;
  } catch {
    return null;
  }
}

export function persistQueryPlan(projectRoot: string, stored: StoredQueryPlan): void {
  const dir = plansDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(planStorePath(projectRoot, stored.topic), `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function deletePersistedQueryPlan(projectRoot: string, topic: string): void {
  try {
    fs.unlinkSync(planStorePath(projectRoot, topic));
  } catch {
    /* absent */
  }
}

/** Persist plan when adding a watch — cron replays the same subqueries. */
export async function ensureQueryPlanForWatch(
  projectRoot: string,
  topic: string,
): Promise<StoredQueryPlan> {
  migrateLegacyLast30daysState(projectRoot);
  const existing = loadPersistedQueryPlan(projectRoot, topic);
  if (existing) return existing;
  const built = await buildStoredQueryPlan(topic);
  persistQueryPlan(projectRoot, built);
  return built;
}

function writeRuntimePlanFile(projectRoot: string, plan: QueryPlanJson): string {
  const filePath = runtimePlanPath(projectRoot);
  fs.writeFileSync(filePath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

function bundleFromStored(projectRoot: string, stored: StoredQueryPlan): QueryPlanBundle {
  return {
    planPath: writeRuntimePlanFile(projectRoot, stored.plan),
    search: stored.search,
    subreddits: stored.subreddits,
    kind: stored.kind,
  };
}

/** Resolve plan for a research or watch run (internal — not exposed to GUI). */
export async function resolveQueryPlanBundle(
  projectRoot: string,
  topic: string,
  opts: { preferPersisted?: boolean; persistForWatch?: boolean } = {},
): Promise<QueryPlanBundle | null> {
  const t = topic.trim();
  if (!t) return null;

  migrateLegacyLast30daysState(projectRoot);

  let stored: StoredQueryPlan | null = null;
  if (opts.preferPersisted) {
    stored = loadPersistedQueryPlan(projectRoot, t);
  }
  if (!stored) {
    stored = await buildStoredQueryPlan(t);
    if (opts.persistForWatch) {
      persistQueryPlan(projectRoot, stored);
    }
  }
  return bundleFromStored(projectRoot, stored);
}

/** Merge `--plan`, `--search`, `--subreddits` into a research request (idempotent). */
export function applyQueryPlanBundle(
  req: ResearchRequest,
  bundle: QueryPlanBundle | null,
): ResearchRequest {
  if (!bundle) return req;
  const extra = [...(req.extraArgs || [])];
  const hasPlan = extra.some((a) => a.startsWith("--plan"));
  if (!hasPlan) {
    extra.push(`--plan=${bundle.planPath}`);
  }
  const out: ResearchRequest = { ...req, extraArgs: extra };
  if (bundle.search && !req.search) {
    out.search = bundle.search;
  }
  if (bundle.subreddits && !req.subreddits) {
    out.subreddits = bundle.subreddits;
  }
  // Multi-subquery host plans: Thorough beats Simple.
  // Engine --quick collapses external plans to 1 subquery and can inject `jobs` when
  // `--search=` is missing — that poisoned "LA Tech Week 2026" with Taskworks spam.
  // Named-entity plans are LLM-built too (2–4 angles), so they must not stay on --quick.
  if (
    (bundle.kind === "concept" ||
      bundle.kind === "comparison" ||
      bundle.kind === "event" ||
      bundle.kind === "named_entity" ||
      bundle.kind === "product" ||
      bundle.kind === "person") &&
    req.quick &&
    !req.deep
  ) {
    out.quick = false;
    out.deep = false;
  }
  return out;
}

/** True when this request should receive host-side planning. */
export function shouldApplyQueryPlan(req: ResearchRequest): boolean {
  if (req.mock) return false;
  const mode = req.mode || "research";
  if (mode !== "research") return false;
  if (!req.topic?.trim()) return false;
  // Caller already passed an explicit plan path.
  if (req.extraArgs?.some((a) => a.startsWith("--plan"))) return false;
  return true;
}

export async function enrichResearchRequest(
  projectRoot: string,
  req: ResearchRequest,
  opts: { preferPersisted?: boolean; persistForWatch?: boolean } = {},
): Promise<ResearchRequest> {
  if (!shouldApplyQueryPlan(req)) return req;
  const bundle = await resolveQueryPlanBundle(projectRoot, req.topic!.trim(), opts);
  return applyQueryPlanBundle(req, bundle);
}
