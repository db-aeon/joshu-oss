/**
 * Fact extraction step of the research pipeline: one model call for each sub-question, in
 * parallel. Each fact has an exact quote, and the box keeps a fact only when its quote is in the
 * text of its page. Design decision D1. The call gets what the topic means and what it is not, and
 * skips a fact about a different thing with a similar name, also when the page itself mixes the
 * two up (change recurring-research-reports, D14).
 */

import type { Fact, ResearchPlan, SubQuestion, WebPage } from "../types.js";
import { asString, callJson, mapLimit, type JsonCallOpts } from "./llm.js";

const TEXT_PER_PAGE = 5000;
const TEXT_PER_CALL = 26_000;
const MAX_FACTS_PER_QUESTION = 10;

const SYSTEM = `You extract facts from web pages for a research report.
Return JSON only: {"facts": [{"claim": string, "quote": string, "page_id": string}]}
Rules:
- Up to ten facts that answer the question, the most important first. Prefer facts with numbers, dates, names, and results.
- claim: the fact in one plain sentence of your own.
- quote: copied exactly, word for word, from the text of the page, 10 to 40 words. Do not change or join text.
- page_id: the id of the page that the quote comes from.
- Use only the pages given. Skip pages that do not answer the question. Skip marketing claims without evidence.
- "About" says what the topic means, and "Not about" lists things with a similar name. Skip each fact about one of those other things. A page can mix up two things with the same name: when the facts of a passage fit the other thing better than the topic, skip them.`;

/**
 * The lines of a model call that say what the topic means and what it is not, and the search terms
 * that a lane of a recurring report follows (change research-keyword-expansion).
 */
export function aboutLines(plan: Pick<ResearchPlan, "about" | "notAbout"> & { namedTerms?: string[]; expandedTerms?: string[] }): string {
  const terms = [...(plan.namedTerms ?? []), ...(plan.expandedTerms ?? [])];
  return [
    ...(plan.about ? [`About: ${plan.about}`] : []),
    ...(plan.notAbout?.length ? [`Not about: ${plan.notAbout.join("; ")}`] : []),
    ...(terms.length ? [`Follows: ${terms.join("; ")}`] : []),
  ]
    .map((l) => `${l}\n`)
    .join("");
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Below this length, the full text of a page is often a paywall, so the passages come first (change research-report-sources, D3). */
const SHORT_TEXT = 1000;

export function pageText(page: WebPage): string {
  if (page.text && page.text.length >= SHORT_TEXT) return page.text;
  return [...page.highlights, page.text ?? ""].filter(Boolean).join("\n");
}

/** The pages for one sub-question: the ones its searches found, then others with text, within the size limit. */
export function pagesForQuestion(q: SubQuestion, pages: WebPage[]): WebPage[] {
  const ordered = [...pages.filter((p) => p.foundBy.includes(q.id)), ...pages.filter((p) => !p.foundBy.includes(q.id) && p.text)];
  const out: WebPage[] = [];
  let size = 0;
  for (const page of ordered) {
    const len = Math.min(pageText(page).length, TEXT_PER_PAGE);
    if (len < 80) continue;
    if (size + len > TEXT_PER_CALL && out.length) break;
    out.push(page);
    size += len;
  }
  return out;
}

/** Keep the facts whose quote is in their page, and number them `F1`, `F2`, ... across all questions. */
export function checkFacts(
  answers: { subQuestionId: string; raw: unknown }[],
  pages: WebPage[],
): Fact[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const { subQuestionId, raw } of answers) {
    const list = raw && typeof raw === "object" && Array.isArray((raw as { facts?: unknown }).facts) ? (raw as { facts: unknown[] }).facts : [];
    let kept = 0;
    for (const f of list) {
      if (!f || typeof f !== "object" || kept >= MAX_FACTS_PER_QUESTION) continue;
      const w = f as Record<string, unknown>;
      const page = byId.get(asString(w.page_id));
      const quote = asString(w.quote).replace(/^["“]|["”]$/g, "");
      const claim = asString(w.claim);
      if (!page || !claim || quote.length < 12) continue;
      const nq = normalizeText(quote);
      if (!normalizeText(pageText(page)).includes(nq) || seen.has(nq)) continue;
      seen.add(nq);
      facts.push({ id: `F${facts.length + 1}`, claim, quote, pageId: page.id, subQuestionId });
      kept += 1;
    }
  }
  return facts;
}

/**
 * Extract the facts for every sub-question in parallel. A failed call gives no facts for that
 * question. `select` picks the pages of a question; the default is `pagesForQuestion`. A theme
 * reads only its own pages (change research-report-topics, D6).
 */
export async function extractFacts(
  topic: string,
  plan: Pick<ResearchPlan, "about" | "notAbout" | "subQuestions">,
  pages: WebPage[],
  deadline: number,
  opts: Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot"> = {},
  select: (q: SubQuestion) => WebPage[] = (q) => pagesForQuestion(q, pages),
): Promise<Fact[]> {
  const answers = await mapLimit(plan.subQuestions, plan.subQuestions.length, async (q) => {
    const subset = select(q);
    if (!subset.length) return { subQuestionId: q.id, raw: null };
    const user = `Topic: ${topic}\n${aboutLines(plan)}Question: ${q.question}\n\n${subset
      .map((p) => `[${p.id}] ${p.title} (${p.site}${p.publishedAt ? `, ${p.publishedAt}` : ""})\n${pageText(p).slice(0, TEXT_PER_PAGE)}`)
      .join("\n\n---\n\n")}`;
    try {
      const { value } = await callJson({ ...opts, step: "extract", system: SYSTEM, user, deadline, maxTokens: 3000 });
      return { subQuestionId: q.id, raw: value };
    } catch {
      return { subQuestionId: q.id, raw: null };
    }
  });
  return checkFacts(answers, pages);
}
