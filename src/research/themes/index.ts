/**
 * The themes of a Research report or a report update (change research-report-topics, design
 * decision D1): sort the stories into themes, read the best pages of each theme, extract facts,
 * write each theme and the summary, and build the links. A Research report calls it in mode
 * `report`, with its background questions or the sections of the owner and its search pages. A run
 * and a repeat request call it in mode `update`, with the new and developing stories only.
 */

import { ResearchStepError, type ResearchStep } from "../errors.js";
import type { ExaClient } from "../pipeline/exa.js";
import { extractFacts, pagesForQuestion } from "../pipeline/extract.js";
import type { JsonCallOpts } from "../pipeline/llm.js";
import { QUIET_FACT_COUNT, type ReportSection } from "../pipeline/write.js";
import type { Fact, ResearchPlan, SubQuestion, WebPage } from "../types.js";
import type { UpdateStory } from "../recurring/types.js";
import { themeLinks } from "./links.js";
import { themePages } from "./read.js";
import { MAX_THEMES, sortThemes, type ThemeDraft } from "./sort.js";
import { writeSummary, writeThemes, type ThemeSummary } from "./write.js";

export { MAX_THEMES, notesThemeLimit, type ThemeDraft } from "./sort.js";
export type { ThemeSummary } from "./write.js";

/** The time limits of the theme steps in milliseconds (design decision D12). */
export type ThemeLimits = { themes: number; read: number; extract: number; write: number; summary: number };

export type BuildThemesInput = {
  mode: "report" | "update";
  topic: string;
  plan: Pick<ResearchPlan, "about" | "notAbout">;
  notes: string;
  /** The stories to sort into themes: the new and developing stories, the most important first. */
  stories: UpdateStory[];
  /** Mode `report`: the background questions of the plan, one background theme each. */
  background?: SubQuestion[];
  /** Mode `report`: one question for each section of the owner (with `section` set), in order. */
  sections?: SubQuestion[];
  /** Mode `report`: the search pages, which the background themes and the sections read. */
  pages?: WebPage[];
  /** The most themes; default `MAX_THEMES`. */
  limit?: number;
  exa: ExaClient | null;
  limits: ThemeLimits;
  llm?: Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot">;
};

export type BuiltThemes = {
  themes: ReportSection[];
  facts: Fact[];
  /** Every page of the report: the search pages and a page for each page or post of a story. */
  pages: WebPage[];
  summary: ThemeSummary;
  /** True when the box found little: fewer than three themes, or fewer facts than a full Research report needs. */
  quiet: boolean;
  dropped: string[];
};

async function timed<T>(name: ResearchStep, ms: number, fn: (deadline: number) => Promise<T>): Promise<T> {
  try {
    return await fn(Date.now() + ms);
  } catch (err) {
    throw err instanceof ResearchStepError ? err : new ResearchStepError(name, (err as Error).message);
  }
}

/** Make the themes, the facts, and the summary. Throws `ResearchStepError` ("extract" or "write") when nothing can be written. */
export async function buildThemes(input: BuildThemesInput): Promise<BuiltThemes> {
  const limit = Math.max(1, Math.min(input.limit ?? MAX_THEMES, MAX_THEMES));
  const sections = input.sections ?? [];
  const background = sections.length ? [] : (input.background ?? []).slice(0, Math.max(0, limit - 1));
  const storiesById = new Map(input.stories.map((s) => [s.id, s]));
  const questions = new Map([...background, ...sections].map((q) => [q.id, q.question]));

  const drafts: ThemeDraft[] = background.map((q, i) => ({ id: `t${i + 1}`, kind: "background", label: q.question, questionId: q.id, storyIds: [] }));
  drafts.push(
    ...(await timed("themes", input.limits.themes, (deadline) =>
      sortThemes(input.stories, {
        topic: input.topic,
        plan: input.plan,
        notes: input.notes,
        limit: Math.max(1, limit - background.length),
        ...(sections.length ? { sections: sections.map((q) => ({ label: q.section ?? q.question, questionId: q.id })) } : {}),
        firstId: drafts.length + 1,
        deadline,
        ...(input.llm ? { llm: input.llm } : {}),
      }),
    )),
  );

  const pages = await timed("search", input.limits.read, (deadline) => themePages(drafts, storiesById, input.pages ?? [], input.exa, deadline));
  const searchQuestions = new Map([...background, ...sections].map((q) => [q.id, q]));
  // A page of a story belongs to the theme of the story. A background theme or a section reads the
  // pages of its question without them, because the fact step keeps each quote once, for the first
  // theme that cites it, and the news theme would lose its facts.
  const storyThemes = new Set(drafts.filter((d) => d.storyIds.length).map((d) => d.id));
  const select = (q: SubQuestion): WebPage[] => {
    const draft = drafts.find((d) => d.id === q.id);
    if (!draft) return [];
    const own = pages.filter((p) => p.foundBy.includes(draft.id));
    const asked = draft.questionId ? searchQuestions.get(draft.questionId) : undefined;
    const searched = asked ? pagesForQuestion(asked, pages).filter((p) => !own.includes(p) && !p.foundBy.some((id) => storyThemes.has(id))) : [];
    return [...searched, ...own];
  };
  const facts = await timed("extract", input.limits.extract, (deadline) =>
    extractFacts(
      input.topic,
      { ...input.plan, subQuestions: drafts.map((d) => ({ id: d.id, question: d.kind === "background" ? d.label : `${d.label}`, recentQuery: "", evergreenQuery: "" })) },
      pages,
      deadline,
      input.llm,
      select,
    ),
  );
  if (!facts.length) throw new ResearchStepError("extract", "the pages gave no facts that could be checked");

  const dropped: string[] = [];
  const themes = await timed("write", input.limits.write, (deadline) =>
    writeThemes(drafts, facts, pages, storiesById, { topic: input.topic, plan: input.plan, notes: input.notes, questions, deadline, ...(input.llm ? { llm: input.llm } : {}) }, dropped),
  );
  const factById = new Map(facts.map((f) => [f.id, f]));
  const pageById = new Map(pages.map((p) => [p.id, p]));
  for (const theme of themes) theme.links = themeLinks(theme, storiesById, factById, pageById);

  const quiet = themes.length < 3 || (input.mode === "report" && facts.length < QUIET_FACT_COUNT);
  const summary = await writeSummary(
    themes,
    facts,
    { topic: input.topic, plan: input.plan, notes: input.notes, quiet, cover: input.mode === "report", deadline: Date.now() + input.limits.summary, pages, ...(input.llm ? { llm: input.llm } : {}) },
    dropped,
  );
  return { themes, facts, pages, summary, quiet, dropped };
}
