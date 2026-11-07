/**
 * The theme step (change research-report-topics, design decision D5): one model call sorts the new
 * and developing stories of a report into themes. A theme holds one or more stories about the same
 * subject, from any lane and any source. With sections of the owner, the call puts each story in a
 * section instead, and code keeps the order of the owner.
 */

import { aboutLines } from "../pipeline/extract.js";
import { asString, asStringArray, callJson, type JsonCallOpts } from "../pipeline/llm.js";
import type { ResearchPlan } from "../types.js";
import { storyWeight } from "../recurring/stories.js";
import type { UpdateStory } from "../recurring/types.js";

/** A report has at most this many themes (spec `research-report-themes`). */
export const MAX_THEMES = 7;

/** A theme before the writer: its stories, or the question of the plan that it answers. */
export type ThemeDraft = {
  /** `t1`, `t2`, ... inside one report. */
  id: string;
  kind: "background" | "news" | "section";
  /** A headline draft, the section of the owner, or the background question. */
  label: string;
  /** The sub-question of the plan whose pages the theme also reads (background themes and sections). */
  questionId?: string;
  storyIds: string[];
};

type Llm = Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot">;

/**
 * The number of themes that the notes allow, for example 5 for "keep it to 5" or "at most 8 items"
 * (design decision D11). A live writer wrote 24 items for "at most 8 items", so code gives the
 * theme step only that many.
 */
export function notesThemeLimit(notes: string): number | undefined {
  const m =
    notes.match(/\b(?:at most|no more than|max(?:imum)?(?: of)?|up to|keep it to|limit(?: it)? to|only)\s+(\d{1,2})\s+(?:items?|stories|story|themes?|bullets?|headlines?|links?|news items?)\b/i) ??
    notes.match(/\b(\d{1,2})\s+(?:items?|stories|themes?|bullets?|headlines?)\s+(?:max(?:imum)?|at most|total)\b/i) ??
    // "Keep it to 5." names no unit; a unit such as "minutes" or "sources" is not a limit of themes.
    notes.match(/\b(?:keep it to|limit(?: it)? to)\s+(\d{1,2})\b(?!\s*[a-z])/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const THEMES_SYSTEM = (limit: number) => `You sort the stories of a news report into themes.
Return JSON only: {"themes": [{"label": string, "stories": [string]}]}
Rules:
- A theme is one subject: one event, or a few related events of the same kind, for example two funding rounds in the same market, or a new rule and the reactions to it. Do not join stories that only share the topic of the report.
- A story with much coverage can be a theme on its own.
- stories: the story keys, for example "S3". Each story is in at most one theme.
- At most ${limit} themes, the most important first: the most pages, posts, and sources, and what matters most to the owner. Leave out the least important stories when they do not fit.
- label: a plain headline of at most twelve words that names what happened.
- Leave out a story that is not about the topic. "About" says what the topic means, and "Not about" lists things with a similar name.
- Follow the notes of the owner on what comes first and what to leave out.`;

const SECTIONS_SYSTEM = `You sort the stories of a report into the sections of the owner.
Return JSON only: {"sections": [{"section": number, "stories": [string]}]}
Rules:
- section: the number of a section of the owner. stories: the story keys, for example "S3".
- Put each story in the one section that it belongs to, or leave it out when it fits no section. Each story is in at most one section.
- Leave out a story that is not about the topic. "About" says what the topic means, and "Not about" lists things with a similar name.`;

function storyLine(s: UpdateStory): string {
  const fresh = s.items.filter((i) => s.newItems.includes(i.url)).length;
  return `[${s.id}] (${s.status}) ${s.title}. ${s.summary} (sources: ${s.sources.join(", ")}; ${fresh} new pages and posts)`;
}

/** One theme for each story, the heaviest first: the themes when the theme call fails. */
function storyThemes(stories: UpdateStory[], limit: number): ThemeDraft[] {
  return [...stories]
    .sort((a, b) => storyWeight(b) - storyWeight(a))
    .slice(0, limit)
    .map((s, i) => ({ id: `t${i + 1}`, kind: "news", label: s.title, storyIds: [s.id] }));
}

/**
 * Sort `stories` into themes, at most `limit`, or into the `sections` of the owner (one draft for
 * each section, in order, also when no story fits it). Theme identifiers start after `firstId`.
 * When the call fails, each story is its own theme, so a report still goes out.
 */
export async function sortThemes(
  stories: UpdateStory[],
  opts: { topic: string; plan: Pick<ResearchPlan, "about" | "notAbout">; notes: string; limit: number; sections?: { label: string; questionId?: string }[]; firstId?: number; deadline: number; llm?: Llm },
): Promise<ThemeDraft[]> {
  const first = opts.firstId ?? 1;
  const sections = opts.sections ?? [];
  const known = new Set(stories.map((s) => s.id));
  const renumber = (drafts: ThemeDraft[]) => drafts.map((d, i) => ({ ...d, id: `t${first + i}` }));
  const empty = sections.map((s): ThemeDraft => ({ id: "", kind: "section", label: s.label, ...(s.questionId ? { questionId: s.questionId } : {}), storyIds: [] }));
  if (!stories.length) return renumber(empty);

  const user = `Topic: ${opts.topic}\n${aboutLines(opts.plan)}${opts.notes.trim() ? `Notes of the owner: ${opts.notes.trim()}\n` : ""}${
    sections.length ? `Sections of the owner:\n${sections.map((s, i) => `${i + 1}. ${s.label}`).join("\n")}\n` : ""
  }\nStories:\n${stories.map(storyLine).join("\n")}`;
  try {
    const { value } = await callJson<ThemeDraft[]>({
      ...opts.llm,
      step: "themes",
      system: sections.length ? SECTIONS_SYSTEM : THEMES_SYSTEM(opts.limit),
      user,
      deadline: opts.deadline,
      maxTokens: 400 + 30 * stories.length,
      check: (raw) => {
        const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const used = new Set<string>();
        const take = (ids: unknown) =>
          asStringArray(ids).filter((id) => {
            if (!known.has(id) || used.has(id)) return false;
            used.add(id);
            return true;
          });
        if (sections.length) {
          const drafts = empty.map((d) => ({ ...d, storyIds: [] as string[] }));
          for (const s of Array.isArray(o.sections) ? o.sections : []) {
            const w = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
            const n = Number(w.section);
            if (Number.isInteger(n) && drafts[n - 1]) drafts[n - 1]!.storyIds.push(...take(w.stories));
          }
          return drafts;
        }
        const drafts = (Array.isArray(o.themes) ? o.themes : []).flatMap((t): ThemeDraft[] => {
          const w = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
          const storyIds = take(w.stories);
          const label = asString(w.label);
          return storyIds.length && label ? [{ id: "", kind: "news", label: label.slice(0, 120), storyIds }] : [];
        });
        return drafts.length ? drafts.slice(0, opts.limit) : null;
      },
    });
    return renumber(value);
  } catch {
    return renumber(sections.length ? empty : storyThemes(stories, opts.limit));
  }
}
