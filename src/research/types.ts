/** Shared types of the research module (glossary: Research report). */

/** The state of one source in one collection (spec `research-reports`). */
export type SourceStateName = "returned items" | "returned no items" | "could not be reached";

export type SourceState = {
  /** Source name, for example `reddit` or `news`. */
  name: string;
  /** Name for the owner, for example `Reddit` or `Web`. */
  label: string;
  state: SourceStateName;
  /** The raw status of the call, for example `ok`, `rate limited`, or `no relay`. */
  engineStatus: string;
};

export type CollectedItem = {
  /** Short identifier inside one Research report (`i1`, `i2`, ...). The writer quotes by it. */
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  sourceLabel: string;
  /** `YYYY-MM-DD`, or undefined when the source gives no publication date. */
  publishedAt?: string;
  engagement: Record<string, number>;
  relevance: number;
  /** Index into `CollectedResearch.themes`, or undefined when the item has no theme. */
  theme?: number;
};

export type CollectedTheme = {
  index: number;
  title: string;
  summary: string;
  itemIds: string[];
};

export type CollectedResearch = {
  topic: string;
  windowDays: number;
  /** ISO time of the collection. */
  collectedAt: string;
  items: CollectedItem[];
  themes: CollectedTheme[];
  sources: SourceState[];
};

/** The plan of the research pipeline (design decision D1 of change research-reports). */
export type SubQuestion = {
  /** `q1`, `q2`, ... */
  id: string;
  question: string;
  /** Searched in the last 30 days. */
  recentQuery: string;
  /** Searched without a date limit; aims at primary sources. */
  evergreenQuery: string;
  /** Google Scholar query when the sub-question asks what research shows (change research-report-sources, D2). */
  scholarQuery?: string;
  /** The section of the owner that this sub-question researches (change recurring-research-reports, D15). */
  section?: string;
  /**
   * A background question (what the topic is, the players, the market) gets a background theme; the
   * pages of a news question join the stories of the last 30 days (change research-report-topics, D7).
   */
  kind?: "background" | "news";
  /** The search terms of the plan that this sub-question searches by name (change research-keyword-expansion). */
  terms?: string[];
};

/** What the owner asked for besides the topic (change recurring-research-reports, D14 and D15). */
export type ReportRequest = {
  /** What the owner said about the topic, for example "not Hippo's Clara". */
  notes?: string;
  /** The sections of the owner, in order, for example ["funding", "competitors"]. */
  sections?: string[];
  /**
   * Hints that the companion took from its skills (change content-router, D8), for example
   * "Polymarket for prediction market odds". A hint adds a content goal or names a preferred provider.
   */
  hints?: string[];
};

/** A content goal that the plan adds for a hint (change content-router, D5). */
export type ExtraGoal = {
  /** The kind of source, for example "prediction market odds". */
  kind: string;
  /** The search words of the goal, for example "2028 primaries". */
  query: string;
  /** The provider that the hint names, for example "Polymarket". */
  prefer?: string;
};

/** The one public company that a topic is about (change research-report-sources, D2). */
export type PlanCompany = { name: string; ticker: string; exchange: string };

export type ResearchPlan = {
  brief: string;
  /**
   * One sentence on what the topic means, for example which company of that name (change
   * recurring-research-reports, D14). The fact step skips facts about anything else.
   */
  about?: string;
  /** Companies, products, or people with a similar name that the report is not about. */
  notAbout?: string[];
  subQuestions: SubQuestion[];
  company?: PlanCompany;
  /** A short keyword query for the social sources (change recurring-research-reports, D10). */
  socialQuery?: string;
  /** Content goals that the hints add to the default social goals (change content-router, D5). */
  extraGoals?: ExtraGoal[];
  /**
   * The search terms (change research-keyword-expansion): what the owner named, as the owner wrote
   * it, and the terms that the plan adds for what the owner wants. Each one is in `terms` of one
   * sub-question.
   */
  namedTerms?: string[];
  expandedTerms?: string[];
};

/**
 * The sources that can find a page (change research-report-sources, D3). `post` is a social post or
 * an item of the content router that a theme reads with its own text (change research-report-topics).
 */
export type PageSource = "web" | "news" | "scholar" | "prices" | "filings" | "post";

/** One web page that the research found. */
export type WebPage = {
  /** `p1`, `p2`, ... in rank order. */
  id: string;
  url: string;
  title: string;
  /** Host without `www.`, for example `nytimes.com`. */
  site: string;
  publishedAt?: string;
  /** Passages that match the sub-question. */
  highlights: string[];
  /** Full text, for the best pages only. */
  text?: string;
  /** The page image (usually og:image). */
  image?: string;
  /** Images inside the page, with alt text. */
  pictures: { url: string; alt: string }[];
  /** Sub-questions whose searches found this page. */
  foundBy: string[];
  /** Sources that found this page. */
  foundVia: PageSource[];
  score: number;
};

/** One fact with its exact quote from a page. */
export type Fact = {
  /** `F1`, `F2`, ... */
  id: string;
  claim: string;
  quote: string;
  pageId: string;
  subQuestionId: string;
};

/** Everything that the research steps found for one topic. */
export type Research = {
  topic: string;
  /** ISO time when the research started. */
  collectedAt: string;
  /** Day of the request in the time zone of the owner, `YYYY-MM-DD`. */
  day: string;
  plan: ResearchPlan;
  /** The notes and sections of the owner, when the owner gave them. */
  request?: ReportRequest;
  pages: WebPage[];
  facts: Fact[];
  /** Posts for the box "What people are saying" of a report from before change research-report-topics; empty now, because posts are in the themes. */
  social: CollectedItem[];
  sources: SourceState[];
};
