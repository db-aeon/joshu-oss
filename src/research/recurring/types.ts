/**
 * Types of recurring reports and report updates (change recurring-research-reports; glossary:
 * Recurring report, Lane, Report update, Story, Story status). Every type here is stored as plain
 * JSON in the files of the owner, so a reader with no Joshu code can read it.
 */

import { goalOfSource } from "../../contentRouter/goals.js";
import type { ReportSection } from "../pipeline/write.js";
import type { ExtraGoal, Fact, PlanCompany, SourceState, WebPage } from "../types.js";

/**
 * A source of a report (change content-router, design decision D5): a base source (`web`,
 * `papers`, `company`), the id of a default social goal (`reddit`, `x`, `youtube`, `tiktok`,
 * `instagram`), or `goal:` and a goal kind, for example `goal:prediction market odds`. The social
 * ids map to content goals at read time, so a saved recurring report with the old ids keeps working.
 */
export type ResearchSourceId = string;

/** The sources that the owner can pick in the Research app (spec `recurring-research-reports`). */
export const RESEARCH_SOURCE_IDS: readonly ResearchSourceId[] = ["web", "papers", "company", "reddit", "x", "youtube", "tiktok", "instagram"];

/** True for a known source id or a `goal:` id. */
export function isResearchSourceId(id: string): boolean {
  return RESEARCH_SOURCE_IDS.includes(id) || (id.startsWith("goal:") && id.length > 5);
}

/** The name of a source for the owner, for example "Reddit" or "Prediction market odds". */
export function researchSourceLabel(id: ResearchSourceId): string {
  return RESEARCH_SOURCE_LABELS[id] ?? goalOfSource(id)?.label ?? id;
}

export const RESEARCH_SOURCE_LABELS: Record<string, string> = {
  web: "Web and news",
  papers: "Research papers",
  company: "Company data",
  reddit: "Reddit",
  x: "X",
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
};

/** The channels of report updates. A Hermes cron job cannot deliver to jChat, so jChat is not one. */
export type ReportChannel = "email" | "sms" | "slack" | "telegram";
export const REPORT_CHANNELS: readonly ReportChannel[] = ["email", "sms", "slack", "telegram"];

/** The lane plan of design decision D2: made once when the lane is made or its topic changes. */
export type LanePlan = {
  /** The sources that Auto picked, with Web and news always first. */
  picks: ResearchSourceId[];
  /** One sentence on why Auto picked these sources. */
  reason: string;
  webQueries: string[];
  newsQuery: string;
  socialQuery: string;
  /** Empty when the topic has no research papers. */
  scholarQuery: string;
  /** The one public company of the lane, when the topic is about one. */
  company?: PlanCompany;
  /** Content goals that the hints add to this lane (change content-router, D5). */
  extraGoals?: ExtraGoal[];
  /** One sentence on what the topic means (D14). The group step leaves out items about anything else. */
  about?: string;
  /** Things with a similar name that the topic is not about (D14). */
  notAbout?: string[];
  /**
   * The search terms (change research-keyword-expansion): what the owner named, as the owner wrote
   * it, and the terms that the plan adds for what the owner wants. Each run searches them by name.
   * A lane plan from before the change has neither, and gets both at its next run.
   */
  namedTerms?: string[];
  expandedTerms?: string[];
  madeAt: string;
};

export type Lane = {
  /** `l1`, `l2`, ... inside one recurring report. */
  id: string;
  topic: string;
  /** Search words from the owner or from the Watch migration. The lane plan uses them as hints. */
  hints?: string[];
  plan?: LanePlan;
  addedAt: string;
  /** The first run with this lane that worked (sent a report update or found nothing new). Until then the lane gets a starting update. */
  firstRunAt?: string;
};

export type RecurringState = "active" | "paused" | "deleted";

export type RunResult = "delivered" | "nothing new" | "failed" | "skipped";

export type RunSummary = {
  at: string;
  result: RunResult;
  /** The number of new and developing stories. */
  stories?: number;
  /** The step that failed, for a failed run. */
  step?: string;
  error?: string;
  /** The channel that the box sent on; can differ from the channel of the recurring report (D7). */
  channel?: ReportChannel;
  /** The folder of the report update under `updates/`. */
  folder?: string;
};

/** `setup.json` of one recurring report (design decision D1). */
export type RecurringSetup = {
  schemaVersion: 1;
  /** `rr_` and 8 hex characters. */
  id: string;
  /** The folder name under `Research/Recurring/`. */
  slug: string;
  name: string;
  lanes: Lane[];
  sources: "auto" | ResearchSourceId[];
  /** A Hermes cron expression with one number in the minute field. */
  schedule: string;
  channel: ReportChannel;
  /** For email: the owner addresses of the box profile to mail; default the primary address. */
  emailTo?: string[];
  notes: string;
  /** Hints that the companion took from its skills (change content-router, D8). The lane plans read them. */
  hints?: string[];
  /** The owner asked for a short line when a run finds nothing new. */
  nothingNewLine?: boolean;
  state: RecurringState;
  cronJobId?: string;
  scriptName: string;
  createdAt: string;
  updatedAt: string;
  /** The time of the last report update that the owner got. */
  lastDeliveredAt?: string;
  /**
   * The end of the period of the last run that worked: a run that sent a report update, or a run
   * that found nothing new. The next run covers the period since then. A failed run does not change it.
   */
  lastCoveredAt?: string;
  lastRun?: RunSummary;
  /** Set while a run is going on, so that a second run is skipped and a crash can be found at start. */
  running?: { startedAt: string; runId: string };
  /** The number of runs in a row with nothing new. The Research app shows the report as quiet at 5. */
  nothingNewInARow: number;
  /** How the recurring report was made. */
  origin?: "chat" | "app" | "watch-migration";
};

/** One page or post of a story. */
export type StoryItem = {
  url: string;
  /** A source id of `ResearchSourceId`, or `news` for Google News inside Web and news. */
  source: string;
  sourceLabel: string;
  title: string;
  /** A highlight of a page or the text of a post. */
  text?: string;
  publishedAt?: string;
  engagement?: Record<string, number>;
  /** The run that first found the item. */
  firstRun: string;
};

/** A story in `stories.json` (design decision D4). */
export type StoredStory = {
  /** `S1`, `S2`, ... inside one recurring report or Research report. */
  id: string;
  laneId: string;
  title: string;
  summary: string;
  /** ISO time of the first run that found the story. */
  firstRun: string;
  /** ISO time of the last run that found the story. */
  lastRun: string;
  /** The run identifier of the last report update that showed the story. */
  lastShownRun?: string;
  items: StoryItem[];
};

export type StoriesFile = { schemaVersion: 1; nextNumber: number; stories: StoredStory[] };

export type StoryStatus = "new" | "developing" | "quiet";

/** A story in one report update. */
export type UpdateStory = {
  id: string;
  laneId: string;
  title: string;
  summary: string;
  status: StoryStatus;
  sources: string[];
  items: StoryItem[];
  /** The items that the run found and the stored story did not have (all items for a new story). */
  newItems: string[];
};

/** A page that a theme of a report update cites, for the numbered citations of the PDF. */
export type UpdatePage = Pick<WebPage, "id" | "url" | "title" | "site" | "publishedAt">;

/**
 * `update.json` of one report update (design decision D6). Version 2 (change research-report-topics,
 * D13) adds the summary, the themes, and the facts and pages that the themes cite; version 1 has
 * only the digest.
 */
export type UpdateFile = {
  schemaVersion: 1 | 2;
  /** The run identifier: the folder name under `updates/`. */
  run: string;
  /** The name of the recurring report or the topic of the Research report. */
  name: string;
  kind: "recurring" | "repeat";
  /** The identifier of the recurring report or of the Research report. */
  parentId: string;
  period: { from: string; to: string };
  lanes: { id: string; topic: string; starting: boolean; sources: ResearchSourceId[] }[];
  stories: UpdateStory[];
  sources: SourceState[];
  /** The summary paragraph with `[F12]` citations (version 2). */
  summary?: string;
  /** At most three sentences without citations, for a chat answer (version 2). */
  chat?: string;
  /** The themes of the report update, each with its paragraphs, stories, and links (version 2). */
  themes?: ReportSection[];
  /** The facts that the themes and the summary cite (version 2). */
  facts?: Fact[];
  /** The pages of those facts (version 2). */
  pages?: UpdatePage[];
  /** The text that the box sent on the channel: the digest of version 1, or the themes as text of version 2. */
  digest?: { text: string; channel: ReportChannel; dropped: string[] };
  delivery?: { channel: ReportChannel; at: string; result: "delivered" | "failed"; messageId?: string; error?: string };
};
