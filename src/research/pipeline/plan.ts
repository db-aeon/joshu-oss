/**
 * Plan step of the research pipeline: a research brief and four to six sub-questions, each with a
 * recent query and an evergreen query that aims at primary sources. Design decision D1. The plan
 * also marks research questions for Google Scholar and names the one public company of a topic
 * (change research-report-sources, D2). It says what the topic means and what it is not, and it
 * follows the notes and the sections of the owner (change recurring-research-reports, D14 and D15).
 * It also expands the request into search terms, and ties each one to a sub-question (change
 * research-keyword-expansion).
 */

import type { ExtraGoal, PlanCompany, ReportRequest, ResearchPlan, SubQuestion } from "../types.js";
import { asString, asStringArray, callJson, type JsonCallOpts } from "./llm.js";

export const MIN_SUB_QUESTIONS = 4;
export const MAX_SUB_QUESTIONS = 6;
export const MAX_SCHOLAR_QUERIES = 2;
/** The most sections that an owner can ask for; the same as the most theme sections of a report. */
export const MAX_OWNER_SECTIONS = 6;
const MAX_NOT_ABOUT = 4;
/** The most content goals that hints can add to one report (change content-router, D5). */
export const MAX_EXTRA_GOALS = 3;
/** The most hints that the plan reads. */
export const MAX_HINTS = 8;
/** The most named terms and expanded terms of one plan (change research-keyword-expansion). */
export const MAX_NAMED_TERMS = 6;
export const MAX_EXPANDED_TERMS = 10;

/** The rules of the search terms, for the plan of a Research report and for a lane plan. `where` names the places of the owner's words. */
export function termRules(where: string): string {
  return `- named_terms: each company, product, person, or concept that the owner names in ${where}, written as the owner wrote it. At most ${MAX_NAMED_TERMS}. [] when the owner names none.
- expanded_terms: the search terms that the owner most likely wants beyond the named terms, so that the search finds what the owner asked about: for example the main competitors, product names, and the words of the space or market. Each one is a short search phrase, no dates. At most ${MAX_EXPANDED_TERMS}.`;
}

/**
 * The search terms of a plan answer: trimmed, without empty or repeated terms, and without an
 * expanded term that repeats a named term.
 */
export function checkTerms(o: Record<string, unknown>): { namedTerms: string[]; expandedTerms: string[] } {
  const seen = new Set<string>();
  const clean = (raw: unknown, max: number) =>
    asStringArray(raw)
      .map((t) => t.replace(/\s+/g, " ").slice(0, 80))
      .filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
      .slice(0, max);
  // Named terms first, so that an expanded term that repeats one is dropped.
  const namedTerms = clean(o.named_terms, MAX_NAMED_TERMS);
  return { namedTerms, expandedTerms: clean(o.expanded_terms, MAX_EXPANDED_TERMS) };
}

const SYSTEM = `You plan web research for a report for a busy professional.
Return JSON only: {"brief": string, "about": string, "not_about": [string], "named_terms": [string], "expanded_terms": [string], "sub_questions": [{"question": string, "kind": "background" | "news", "recent_query": string, "evergreen_query": string, "scholar_query": string, "terms": [string]}], "company": {"name": string, "ticker": string, "exchange": string} | null, "social_query": string, "extra_goals": [{"goal": string, "query": string, "prefer": string}]}
Rules:
- brief: two sentences on what the report must answer.
- about: one sentence on what the topic means, so that a reader can tell it apart from things with a similar name. For a company, say what it does, and its website when you know it.
- not_about: up to four companies, products, or people with the same or a similar name that the report is not about, each with a few words that tell it apart, for example "Clara, the claims voice agent of Hippo Insurance". [] when you know of none.
- When the owner gave notes, follow them: they can say what the topic means, what it is not, and what to look at.
- sub_questions: when the owner gave sections, exactly one question for each section, in the same order, about that section of the topic. Otherwise four to six questions that together cover the topic: what it is, the current state and recent news, the main players or options, numbers (market size, prices, adoption, results), problems and debates, and what comes next. Leave out the ones that do not fit the topic.
- kind: "background" for a question about what the topic is, who the main players are, or how large its market is; "news" for a question about what happened recently, problems and debates in the news, and what comes next. Without sections, at least one question of each kind.
- recent_query: a web search query for news of the last 30 days on the question. Short keywords, no dates.
- evergreen_query: a web search query for primary and authoritative sources on the question: official sites, research papers, government or company reports, and serious analysis. Short keywords, no dates.
${termRules("the topic or the notes")}
- terms: the named and expanded terms that the question is about, copied exactly. Put each term in one sub-question: for example competitors and products in the question on the main players, and words of the space in the question on news or the market.
- scholar_query: a Google Scholar query only when peer-reviewed studies are the main evidence for the question (medicine, health, nutrition, psychology, natural science, engineering). An empty string for questions about a business, a market, a company, a product, prices, or news. At most two questions get one.
- company: the company when the topic is about one public company, with its stock ticker and its exchange as Google Finance writes them (for example "NVIDIA", "NVDA", "NASDAQ"). null for a market, a product type, a private company, or several companies.
- social_query: two to four keywords that people use on Reddit, X, YouTube, TikTok, and Instagram for the topic. No dates.
- extra_goals: only when hints are given. For each hint that fits the topic and asks for a kind of source that is not Reddit, X, YouTube, TikTok, or Instagram, one goal: "goal" is the kind of source in a few words (for example "prediction market odds"), "query" is two to four keywords for that source, and "prefer" is the provider that the hint names (for example "Polymarket"), or an empty string. At most three. [] when no hint fits.
- Plain words. No marketing language.`;

/** The company of the plan answer, or undefined when the answer names none or leaves out the ticker. */
function checkCompany(raw: unknown): PlanCompany | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const name = asString(c.name);
  const ticker = asString(c.ticker).toUpperCase();
  const exchange = asString(c.exchange).toUpperCase();
  return name && /^[A-Z0-9.\-]{1,10}$/.test(ticker) && exchange ? { name, ticker, exchange } : undefined;
}

/** The hints of the companion: trimmed, short, without empty or repeated ones. */
export function cleanHints(hints: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (hints ?? [])
    .map((h) => (typeof h === "string" ? h.trim().replace(/\s+/g, " ").slice(0, 200) : ""))
    .filter((h) => h && !seen.has(h.toLowerCase()) && seen.add(h.toLowerCase()))
    .slice(0, MAX_HINTS);
}

/** The extra goals of a plan answer: at most three, each with a goal kind and a query. */
export function checkExtraGoals(raw: unknown): ExtraGoal[] {
  const out: ExtraGoal[] = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    if (!g || typeof g !== "object" || out.length >= MAX_EXTRA_GOALS) continue;
    const o = g as Record<string, unknown>;
    const kind = asString(o.goal).slice(0, 60);
    const query = asString(o.query).slice(0, 100);
    const prefer = asString(o.prefer).slice(0, 40);
    if (!kind || !query || out.some((e) => e.kind.toLowerCase() === kind.toLowerCase())) continue;
    out.push({ kind, query, ...(prefer ? { prefer } : {}) });
  }
  return out;
}

/** A section name longer than this is cut at the last whole word before it. */
export const MAX_SECTION_CHARS = 100;

/** `text` cut at the last whole word within `max` characters, without a dangling "and" or comma. */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim();
  return atWord.replace(/[\s,;:(/-]+(?:and|or|the|of|in|for)?$/i, "").replace(/[\s,;:(/-]+$/, "");
}

/**
 * The sections of the owner: trimmed, without empty or repeated ones, at most six, each cut at a
 * whole word. A cut in the middle of a word gave a live report of 2026-11-02 the heading
 * "intelligent document processing (IDP) fo".
 */
export function ownerSections(sections: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (sections ?? [])
    .map((s) => clipWords(s.trim().replace(/\s+/g, " "), MAX_SECTION_CHARS))
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, MAX_OWNER_SECTIONS);
}

/**
 * Parse the plan answer, or null when it has fewer than four usable sub-questions. With sections
 * of the owner, the plan needs one sub-question for each section, and sub-question `i` gets section `i`.
 */
export function checkPlan(raw: unknown, topic: string, sections: string[] = []): ResearchPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const max = sections.length || MAX_SUB_QUESTIONS;
  const subQuestions: SubQuestion[] = [];
  const askedTerms: string[][] = [];
  let scholarQueries = 0;
  for (const q of Array.isArray(o.sub_questions) ? o.sub_questions : []) {
    if (!q || typeof q !== "object" || subQuestions.length >= max) continue;
    const w = q as Record<string, unknown>;
    const question = asString(w.question);
    if (!question) continue;
    askedTerms.push(asStringArray(w.terms).map((t) => t.toLowerCase()));
    const scholarQuery = scholarQueries < MAX_SCHOLAR_QUERIES ? asString(w.scholar_query) : "";
    if (scholarQuery) scholarQueries += 1;
    subQuestions.push({
      id: `q${subQuestions.length + 1}`,
      question,
      kind: asString(w.kind) === "news" ? "news" : "background",
      recentQuery: asString(w.recent_query) || `${topic} ${question}`,
      evergreenQuery: asString(w.evergreen_query) || question,
      ...(scholarQuery ? { scholarQuery } : {}),
      ...(sections[subQuestions.length] ? { section: sections[subQuestions.length] } : {}),
    });
  }
  if (subQuestions.length < (sections.length || MIN_SUB_QUESTIONS)) return null;
  // Each search term goes to the sub-question that lists it, or to the first one.
  const { namedTerms, expandedTerms } = checkTerms(o);
  for (const term of [...namedTerms, ...expandedTerms]) {
    const i = Math.max(0, askedTerms.findIndex((t) => t.includes(term.toLowerCase())));
    (subQuestions[i]!.terms ??= []).push(term);
  }
  const company = checkCompany(o.company);
  const socialQuery = asString(o.social_query);
  const about = asString(o.about);
  const notAbout = asStringArray(o.not_about).slice(0, MAX_NOT_ABOUT);
  const extraGoals = checkExtraGoals(o.extra_goals);
  return {
    brief: asString(o.brief) || `What is known about ${topic}.`,
    ...(about ? { about } : {}),
    ...(notAbout.length ? { notAbout } : {}),
    ...(namedTerms.length ? { namedTerms } : {}),
    ...(expandedTerms.length ? { expandedTerms } : {}),
    subQuestions,
    ...(company ? { company } : {}),
    ...(socialQuery ? { socialQuery } : {}),
    ...(extraGoals.length ? { extraGoals } : {}),
  };
}

/** A plan without a model, used when the plan call fails, so that the research still runs. */
export function fallbackPlan(topic: string, sections: string[] = []): ResearchPlan {
  if (sections.length) {
    return {
      brief: `What is known about ${topic}: ${sections.join(", ")}.`,
      subQuestions: sections.map((section, i) => ({
        id: `q${i + 1}`,
        question: `${section}: ${topic}`,
        recentQuery: `${topic} ${section}`,
        evergreenQuery: `${topic} ${section}`,
        section,
      })),
    };
  }
  const angles: [string, string, "background" | "news"][] = [
    ["What it is and why it matters", "overview explained", "background"],
    ["Recent news and developments", "news", "news"],
    ["Main players, products, or options", "companies products comparison", "background"],
    ["Numbers: market size, prices, adoption, results", "market size statistics report", "background"],
    ["Problems, risks, and debates", "problems criticism risks", "news"],
  ];
  return {
    brief: `What is known about ${topic}, what changed recently, and what the numbers say.`,
    subQuestions: angles.map(([question, words, kind], i) => ({
      id: `q${i + 1}`,
      question: `${question}: ${topic}`,
      kind,
      recentQuery: `${topic} ${words}`,
      evergreenQuery: `${topic} ${words}`,
    })),
  };
}

export async function planResearch(
  topic: string,
  today: string,
  deadline: number,
  opts: Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot"> = {},
  request: ReportRequest = {},
): Promise<ResearchPlan> {
  const sections = ownerSections(request.sections);
  const notes = request.notes?.trim();
  const hints = cleanHints(request.hints);
  const user = [
    `Topic: ${topic}`,
    `Today: ${today}`,
    ...(notes ? [`Notes of the owner: ${notes}`] : []),
    ...(hints.length ? [`Hints:\n${hints.map((h) => `- ${h}`).join("\n")}`] : []),
    ...(sections.length ? [`Sections of the owner:\n${sections.map((s, i) => `${i + 1}. ${s}`).join("\n")}`] : []),
  ].join("\n");
  try {
    const { value } = await callJson<ResearchPlan>({
      ...opts,
      step: "plan",
      system: SYSTEM,
      user,
      deadline,
      maxTokens: 2500,
      check: (raw) => checkPlan(raw, topic, sections),
    });
    return value;
  } catch {
    return fallbackPlan(topic, sections);
  }
}
