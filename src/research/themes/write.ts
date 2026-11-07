/**
 * The theme writer and the summary (change research-report-topics, design decision D8). Each theme
 * is written in its own model call, in parallel, from the facts of its pages, with the headlines of
 * the other themes so that the themes do not repeat each other. One more call then writes the
 * summary from the finished themes. Code checks every sentence with `verifyText`, as for the text
 * of a Research report: a sentence that cites an unknown fact, or has a number that is not in the
 * quote of a fact it cites, is dropped.
 */

import { ResearchStepError } from "../errors.js";
import { aboutLines } from "../pipeline/extract.js";
import { asString, asStringArray, callJson, mapLimit, type JsonCallOpts } from "../pipeline/llm.js";
import { limitSentences, sentenceSupported, sentences, verifyText, type ReportSection } from "../pipeline/write.js";
import type { Fact, ResearchPlan, WebPage } from "../types.js";
import type { UpdateStory } from "../recurring/types.js";
import type { ThemeDraft } from "./sort.js";

type Llm = Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot">;

/** At most this many theme calls run at once. */
export const WRITER_CONCURRENCY = 4;

const CITE = /\[(F\d+)\]/g;

const THEME_SYSTEM = `You write one theme of a report for a busy professional, from a list of facts. Each fact has an id, its source, a claim, and an exact quote.
Return JSON only: {"headline": string, "body": string}
Rules:
- headline: a plain headline of at most twelve words that says what happened, or for a background theme what the theme explains. No citation and no number.
- body: one to three short paragraphs, separated by a blank line, that explain what happened, who is involved, and what it means for the topic. Write connected prose that a reader can follow, not a list of facts.
- Every sentence with a fact ends with its citation, for example "[F12]" or "[F3][F7]". A number must be copied from the quote of a fact that the sentence cites.
- Write only about the subject of this theme, as its label says. Use only the facts given, and leave out each fact that is about the subject of another theme of the report, so that two themes never tell the same thing.
- For a developing story, say what is new since the last report, and give the earlier part in one short clause.
- Follow the notes of the owner, for example a line on why the theme matters to the owner.
- "About" says what the topic means, and "Not about" lists things with a similar name. Never write that the topic is, owns, or makes one of those other things.
- Plain, clear English in complete sentences. No hype, no marketing words, no dashes as punctuation.`;

const SUMMARY_SYSTEM = (cover: boolean, quiet: boolean) => `You write the summary at the top of a report, from its themes. Each theme has a headline and paragraphs with fact citations such as "[F12]".
Return JSON only: {"summary": string, "chat": string${cover ? `, "title": string, "title_emphasis": string, "deck": string, "one_sentence": string, "follow_ups": string[]` : ""}}
Rules:
- summary: one paragraph of two to four sentences that says what happened across the themes and how they connect. Keep the citations of the facts that each sentence uses, for example "[F12]". A number must be copied from a theme sentence with the same citation.
- chat: at most three sentences without citations that name the main themes. It is sent as a chat or text message.${
  quiet ? "\n- The box found little this time. Say so in the summary and in the chat." : ""
}${
  cover
    ? `
- title: the cover title, two to six words that name the topic. title_emphasis: one word of the title to set in italics.
- deck: one or two sentences with the main answer, without citations. one_sentence: the whole report in one sentence, without citations.
- follow_ups: two or three short things the owner could ask next, as verb phrases of at most six words.`
    : ""
}
- Plain, clear English in complete sentences. No hype, no marketing words, no dashes as punctuation.`;

export type ThemeSummary = {
  /** One paragraph with `[F12]` citations, checked like the themes. */
  summary: string;
  /** At most three sentences without citations, for the chat answer. */
  chat: string;
  title?: string;
  titleEmphasis?: string;
  deck?: string;
  oneSentence?: string;
  followUps?: string[];
};

/**
 * The years that a sentence of a theme may name without its cited quote: the publication years of
 * the pages of `facts`, and the years in the quotes of `facts`. A live report of 2026-11-02 dropped
 * "Hippo reported $498 million in Q3 2026" because the quote said "the third quarter", and "Mercor
 * was founded in 2023" because the year was in the quote of another fact of the theme.
 */
export function pageYears(facts: Fact[], pages: Map<string, WebPage>): Set<string> {
  return new Set(facts.flatMap((f) => [...(pages.get(f.pageId)?.publishedAt?.match(/^\d{4}/) ?? []), ...(f.quote.match(/\b(?:19|20)\d{2}\b/g) ?? [])]));
}

function factLine(f: Fact, pages: Map<string, WebPage>): string {
  const page = pages.get(f.pageId);
  const where = page ? `${page.site}${page.publishedAt ? `, ${page.publishedAt.slice(0, 10)}` : ""}` : "";
  return `${f.id} (${where}): ${f.claim} | quote: "${f.quote}"`;
}

function storyLines(draft: ThemeDraft, stories: Map<string, UpdateStory>): string[] {
  return draft.storyIds.flatMap((id) => {
    const s = stories.get(id);
    if (!s) return [];
    return [`- ${s.title} (${s.status}${s.status === "developing" && s.summary ? `; earlier: ${s.summary}` : ""})`];
  });
}

/**
 * Write each draft that has facts. Returns the themes in the order of the drafts; a draft whose
 * call fails or whose text does not pass the check is left out. Throws `ResearchStepError`
 * ("write") when no theme is left.
 */
export async function writeThemes(
  drafts: ThemeDraft[],
  facts: Fact[],
  pages: WebPage[],
  stories: Map<string, UpdateStory>,
  opts: { topic: string; plan: Pick<ResearchPlan, "about" | "notAbout">; notes: string; questions?: Map<string, string>; deadline: number; llm?: Llm },
  dropped: string[],
): Promise<ReportSection[]> {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const written = await mapLimit(drafts, WRITER_CONCURRENCY, async (draft) => {
    const mine = facts.filter((f) => f.subQuestionId === draft.id);
    if (!mine.length) return null;
    const others = drafts.filter((d) => d !== draft).map((d) => `- ${d.label}`);
    const question = draft.questionId ? opts.questions?.get(draft.questionId) : undefined;
    const user = [
      `Topic: ${opts.topic}`,
      aboutLines(opts.plan).trim(),
      opts.notes.trim() ? `Notes of the owner: ${opts.notes.trim()}` : "",
      `Theme (${draft.kind === "background" ? "background" : draft.kind === "section" ? "section of the owner" : "news"}): ${draft.label}${question && question !== draft.label ? `\nQuestion: ${question}` : ""}`,
      ...(draft.storyIds.length ? ["Stories of the theme:", ...storyLines(draft, stories)] : []),
      others.length ? `Other themes of the report:\n${others.join("\n")}` : "",
      "",
      "Facts:",
      ...mine.map((f) => factLine(f, pageById)),
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n");
    try {
      const { value } = await callJson<{ headline: string; body: string }>({
        ...opts.llm,
        step: "write",
        system: THEME_SYSTEM,
        user,
        deadline: opts.deadline,
        maxTokens: 1800,
        check: (raw) => {
          const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
          const headline = asString(o.headline);
          const body = asString(o.body);
          return headline && body ? { headline, body } : null;
        },
      });
      const ownDropped: string[] = [];
      const years = pageYears(mine, pageById);
      const body = verifyText(value.body, byId, ownDropped, [], years);
      dropped.push(...ownDropped);
      if (!body) return null;
      const factIds = [...new Set([...body.matchAll(CITE)].map((m) => m[1]!))];
      const plainHeadline = value.headline.replace(CITE, "").replace(/\.$/, "").trim();
      // A section keeps the words of the owner as its label, and gets a headline like any theme.
      const title = sentenceSupported(plainHeadline, byId, factIds, years) ? plainHeadline : draft.label;
      return { draft, title, body, factIds };
    } catch {
      return null;
    }
  });
  const themes: ReportSection[] = written
    .filter((w): w is NonNullable<typeof w> => w !== null)
    .map((w, index) => ({
      index,
      title: w.title,
      label: w.draft.kind === "section" ? w.draft.label : w.draft.label.split(/\s+/).slice(0, 4).join(" "),
      body: w.body,
      factIds: w.factIds,
      kind: w.draft.kind,
      storyIds: w.draft.storyIds,
    }));
  if (!themes.length) throw new ResearchStepError("write", "no theme could be written from the facts");
  return themes;
}

/** The summary from the first sentence of each theme: the summary when the summary call fails. */
function fallbackSummary(themes: ReportSection[]): ThemeSummary {
  const firsts = themes.slice(0, 3).map((t) => sentences(t.body.split(/\n\s*\n/)[0] ?? "")[0] ?? "").filter(Boolean);
  const summary = firsts.join(" ");
  return { summary, chat: limitSentences(summary.replace(CITE, "").replace(/\s+([.,])/g, "$1"), 3) };
}

/** Write the summary of `themes`; the cover fields too when `cover`. Never throws: a failed call gives the fallback. */
export async function writeSummary(
  themes: ReportSection[],
  facts: Fact[],
  opts: { topic: string; plan: Pick<ResearchPlan, "about" | "notAbout">; notes: string; quiet: boolean; cover: boolean; deadline: number; llm?: Llm; pages?: WebPage[] },
  dropped: string[],
): Promise<ThemeSummary> {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const years = pageYears(facts, new Map((opts.pages ?? []).map((p) => [p.id, p])));
  const user = [
    `Topic: ${opts.topic}`,
    aboutLines(opts.plan).trim(),
    opts.notes.trim() ? `Notes of the owner: ${opts.notes.trim()}` : "",
    "",
    ...themes.map((t, i) => `Theme ${i + 1}: ${t.title}\n${t.body}\n`),
  ]
    .filter((l, i) => l !== "" || i > 0)
    .join("\n");
  try {
    const { value } = await callJson<Record<string, unknown>>({
      ...opts.llm,
      step: "write",
      system: SUMMARY_SYSTEM(opts.cover, opts.quiet),
      user,
      deadline: opts.deadline,
      maxTokens: opts.cover ? 1500 : 900,
      check: (raw) => {
        const o = raw as Record<string, unknown> | null;
        return o && asString(o.summary) ? o : null;
      },
    });
    const summary = verifyText(asString(value.summary).replace(/\n\s*\n/g, " "), byId, dropped, [], years);
    if (!summary) return fallbackSummary(themes);
    const chat = limitSentences(asString(value.chat).replace(CITE, "")) || limitSentences(summary.replace(CITE, ""));
    if (!opts.cover) return { summary, chat };
    return {
      summary,
      chat,
      title: asString(value.title).slice(0, 80),
      titleEmphasis: asString(value.title_emphasis),
      deck: asString(value.deck).replace(CITE, ""),
      oneSentence: limitSentences(asString(value.one_sentence).replace(CITE, ""), 1),
      followUps: asStringArray(value.follow_ups).slice(0, 3),
    };
  } catch {
    return fallbackSummary(themes);
  }
}
