/**
 * The text of a Research report and the checks of every report text. The theme writer of change
 * research-report-topics (`src/research/themes/write.ts`) writes the themes and the summary;
 * `verifyText` drops each sentence with an unknown citation or a number that is not in a cited
 * quote (design decision D2 of change research-reports).
 */

import type { Fact } from "../types.js";

/** Fewer facts than this make a short Research report, which says that the box found little. */
export const QUIET_FACT_COUNT = 8;
const MAX_SUMMARY_SENTENCES = 3;

/** A key finding of a Research report from before change research-report-topics. */
export type ReportFinding = { headline: string; body: string; factIds: string[] };

export type ReportSection = {
  /** Position from 0. */
  index: number;
  /** A claim about the theme. */
  title: string;
  /** Two to four words. */
  label: string;
  /** Paragraphs with `[F12]` citations. */
  body: string;
  factIds: string[];
  /** Background theme, news theme, or a section of the owner (change research-report-topics, D7). */
  kind?: "background" | "news" | "section";
  /** The stories of the theme (change research-report-topics, D5). */
  storyIds?: string[];
  /** The lead link first, then the other pages and posts of the theme, built by code (D9). */
  links?: ThemeLink[];
};

/** A link of a theme: a page or a post with the name of its site or source. */
export type ThemeLink = { url: string; site: string; title: string; publishedAt?: string; counter?: string };

export type ReportText = {
  quiet: boolean;
  /** At most three sentences, sent in the chat with the Research report. */
  summary: string;
  title: string;
  titleEmphasis: string;
  deck: string;
  oneSentence: string;
  /** The summary paragraph with `[F12]` citations. */
  overview: string;
  /** Empty since change research-report-topics; older reports have their key findings. */
  keyFindings: ReportFinding[];
  themes: ReportSection[];
  followUps: string[];
  model: string;
  /** Sentences that the check of D15 dropped (kept in the data file for review). */
  dropped: string[];
};

/**
 * A piece that ends with an abbreviation, for example "U.S.", "H.R.", "e.g.", "Inc.", or "Oct.":
 * its period does not end a sentence. A live report of 2026-11-02 cut "The survey of more than
 * 1,000 U.S. adults" after "U.S." and kept the second half as a broken sentence.
 */
const ABBREVIATION = /(?:^|[\s("'“])(?:(?:[A-Za-z]\.){1,3}|(?:Inc|Corp|Co|Ltd|No|Nos|vs|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Gen|Gov|Sen|Rep|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|approx|est)\.)$/;

/**
 * Split a text into sentences. A sentence ends at ".", "!", or "?" (with closing quotes and
 * citations after it) and a space, so the period of a number such as 4.57 does not end one, and
 * the period of an abbreviation does not end one either.
 */
export function sentences(text: string): string[] {
  const pieces = text
    .trim()
    .split(/(?<=[.!?]["'”’)]*(?:\s*\[F\d+\])*)\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (last !== undefined && ABBREVIATION.test(last)) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** Keep at most `max` sentences. */
export function limitSentences(text: string, max = MAX_SUMMARY_SENTENCES): string {
  return sentences(text).slice(0, max).join(" ");
}

const CITE = /\[(F\d+)\]/g;
/** A number to check: two or more digits, or a decimal, a percent, or a currency amount. */
const NUMBER = /(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?\s?%?/g;

export function numbersIn(text: string): string[] {
  return (text.replace(CITE, " ").match(NUMBER) ?? [])
    .map((n) => n.trim())
    .filter((n) => /\d{2,}|[.%$€£]/.test(n))
    .map((n) => n.replace(/[$€£%\s,]/g, ""));
}

/**
 * Check one sentence: every citation must be a known fact, and every number must appear in the
 * quote of a cited fact (or of `extraFactIds` for a finding headline), or be in `allowed` (the
 * publication years of the pages of a theme). Returns false to drop it.
 */
export function sentenceSupported(sentence: string, facts: Map<string, Fact>, extraFactIds: string[] = [], allowed: ReadonlySet<string> = new Set()): boolean {
  const cited = [...sentence.matchAll(CITE)].map((m) => m[1]!);
  if (cited.some((id) => !facts.has(id))) return false;
  const nums = numbersIn(sentence);
  if (!nums.length) return true;
  const quotes = [...cited, ...extraFactIds].map((id) => (facts.get(id)?.quote ?? "").replace(/,/g, ""));
  return nums.every((n) => allowed.has(n) || quotes.some((q) => q.includes(n)));
}

/** Drop the unsupported sentences of a text; keeps paragraph breaks. */
export function verifyText(text: string, facts: Map<string, Fact>, dropped: string[], extraFactIds: string[] = [], allowed: ReadonlySet<string> = new Set()): string {
  return text
    .split(/\n\s*\n/)
    .map((para) =>
      sentences(para)
        .filter((s) => {
          const ok = sentenceSupported(s, facts, extraFactIds, allowed);
          if (!ok) dropped.push(s);
          return ok;
        })
        .join(" "),
    )
    .filter(Boolean)
    .join("\n\n");
}
