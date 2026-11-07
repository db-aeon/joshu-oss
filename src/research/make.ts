/**
 * Make one Research report with the research pipeline (design decisions D1, D12, D13, D14 of change
 * research-reports, and D1 and D7 of change research-report-topics): plan, search, group the news
 * pages and the social posts of the last 30 days into stories, make the themes (background themes
 * from the background questions, news themes from the stories, or the sections of the owner),
 * pictures, render, and save. The social posts start after the plan, with its keyword query, and
 * are searched in parallel with the web. A failed step leaves no report folder and names the step.
 */

import { reportIdentity, type ReportIdentity } from "./identity.js";
import { getOwnerTimeAnchor } from "../ownerLocalTime.js";
import { ResearchStepError } from "./errors.js";
import { embeddedFontCss } from "./fonts.js";
import { renderPdf } from "./pdf.js";
import { composioSearchClient, type ComposioSearchClient } from "./pipeline/composioSearch.js";
import { exaClient, type ExaClient } from "./pipeline/exa.js";
import { researchModel, type JsonCallOpts } from "./pipeline/llm.js";
import { pickPictures, type Picture } from "./pipeline/pictures.js";
import { cleanHints, ownerSections, planResearch } from "./pipeline/plan.js";
import { searchWeb } from "./pipeline/search.js";
import { webSourceLabel, youClient, type WebProvider } from "./pipeline/you.js";
import { limitSentences, type ReportText } from "./pipeline/write.js";
import { buildThemes, type ThemeLimits } from "./themes/index.js";
import {
  newReportId,
  REPORT_SCHEMA_VERSION,
  resolveReportRoots,
  saveReport,
  type ReportData,
  type ReportRoots,
  type StoredReport,
} from "./store.js";
import { customGoalId } from "../contentRouter/goals.js";
import { collectSocialPool, periodStart, SOCIAL_WINDOW_DAYS, type SocialPoolResult } from "./social/pool.js";
import { goalsOfSources, socialGoalKinds, type GoalRequest, type SocialDeps } from "./social/sources.js";
import type { RunItem } from "./recurring/collect.js";
import type { Lane, ResearchSourceId } from "./recurring/types.js";
import { compareStories, groupStories, reportStories, type RunStory } from "./recurring/stories.js";
import { runId } from "./recurring/run.js";
import { renderReportHtml } from "./template.js";
import type { CollectedItem, ReportRequest, Research, ResearchPlan, SourceState, WebPage } from "./types.js";

/**
 * Time limits of the steps (design decision D12 of change research-reports, and D12 of change
 * research-report-topics). Plan to render take at most 8 minutes; the social posts run in parallel.
 */
export const STEP_LIMITS_MS = {
  plan: 45_000,
  search: 90_000,
  group: 60_000,
  themes: 30_000,
  read: 30_000,
  extract: 60_000,
  write: 90_000,
  summary: 30_000,
  render: 45_000,
  social: 150_000,
} as const;

const THEME_LIMITS: ThemeLimits = { themes: STEP_LIMITS_MS.themes, read: STEP_LIMITS_MS.read, extract: STEP_LIMITS_MS.extract, write: STEP_LIMITS_MS.write, summary: STEP_LIMITS_MS.summary };

export type MakeDeps = {
  /** Null means the box has no Exa key. Default: the Exa key of the box. */
  exa?: ExaClient | null;
  /**
   * The web search provider of this report (change research-web-provider). Default: Exa. With
   * You.com, the search goes through the content router and the full text of the pages stays on Exa.
   */
  webProvider?: WebProvider;
  /** The You.com client (tests pass a fake; null means no content router). Default: the content router of the box. */
  you?: ExaClient | null;
  /** Null means the box has no Composio key. Default: the Composio key of the box (change research-report-sources). */
  composio?: ComposioSearchClient | null;
  /** Model calls (tests pass a fake fetch and key). */
  llm?: Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model">;
  /** The social posts of the pool. Default: the content goals of the box (`collectSocialPool`). */
  social?: (topic: string, query: string, day: string, goals: readonly GoalRequest[]) => Promise<SocialPoolResult>;
  /**
   * The sources that the owner chose in the Research app (change recurring-research-reports, spec
   * `research-report-sources`). Web and news always runs. Default: every source of the box.
   */
  sources?: readonly ResearchSourceId[];
  /** The notes and sections of the owner (change recurring-research-reports, D14 and D15). */
  request?: ReportRequest;
  /** Tests pass a fake content router and a temporary HERMES_HOME for the default social box. */
  socialDeps?: SocialDeps;
  pictureFetch?: typeof fetch;
  writePdf?: (htmlPath: string, pdfPath: string) => Promise<void>;
  roots?: ReportRoots;
  now?: () => Date;
  /** Day of the request in the time zone of the owner (`YYYY-MM-DD`). Default: from the owner profile. */
  day?: string;
  identity?: ReportIdentity;
};

/** The notes, sections, and hints of the owner without empty parts, or undefined when nothing is left. */
export function cleanRequest(request: ReportRequest | undefined): ReportRequest | undefined {
  const notes = request?.notes?.trim();
  const sections = ownerSections(request?.sections);
  const hints = cleanHints(request?.hints);
  return notes || sections.length || hints.length
    ? { ...(notes ? { notes } : {}), ...(sections.length ? { sections } : {}), ...(hints.length ? { hints } : {}) }
    : undefined;
}

/**
 * The content goals of the social posts (change content-router, D5): the default social goals (or
 * the social sources that the owner chose), then the extra goals that the plan made for the hints.
 */
export function reportGoals(plan: ResearchPlan, chosen: ReadonlySet<string> | null, socialDeps: SocialDeps = {}): GoalRequest[] {
  const base = chosen ? goalsOfSources([...chosen], socialDeps) : socialGoalKinds(socialDeps);
  const extra = (plan.extraGoals ?? []).map((g): GoalRequest => ({
    id: customGoalId(g.kind),
    kind: g.kind,
    label: g.kind.charAt(0).toUpperCase() + g.kind.slice(1),
    query: g.query,
    ...(g.prefer ? { prefer: g.prefer } : {}),
  }));
  return [...base, ...extra.filter((g) => !base.some((b) => b.id === g.id))];
}

/** A page or a post of the pool of a Research report, as an item of the group step. */
function pageItem(page: WebPage): Omit<RunItem, "key"> {
  const source = page.foundVia.includes("news") ? "news" : page.foundVia.includes("scholar") ? "papers" : page.foundVia.includes("filings") ? "company" : "web";
  return {
    laneId: "l1",
    url: page.url,
    source,
    sourceLabel: page.site,
    title: page.title,
    text: (page.highlights[0] ?? page.text ?? "").replace(/\s+/g, " ").slice(0, 600),
    ...(page.publishedAt ? { publishedAt: page.publishedAt.slice(0, 10) } : {}),
  };
}

function postItem(post: CollectedItem): Omit<RunItem, "key"> {
  return {
    laneId: "l1",
    url: post.url,
    source: post.source,
    sourceLabel: post.sourceLabel,
    title: post.title,
    text: post.summary,
    ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
    ...(Object.keys(post.engagement).length ? { engagement: post.engagement } : {}),
  };
}

/**
 * The pages of the pool of the last 30 days: dated pages from the window that a news question or a
 * question with search terms found (any question with sections of the owner, or when the plan has
 * no news question). The searches of the search terms only look at the last 30 days, so their pages
 * are news also when the model put a term in a background question (change
 * research-keyword-expansion). The stock price page is company data for the background, not news.
 * Undated pages only serve background themes.
 */
export function newsPages(plan: ResearchPlan, pages: WebPage[], since: string): WebPage[] {
  const newsIds = plan.subQuestions.filter((q) => q.kind === "news" || q.terms?.length).map((q) => q.id);
  const anyQuestion = !newsIds.length || plan.subQuestions.some((q) => q.section);
  return pages.filter(
    (p) => p.publishedAt && p.publishedAt.slice(0, 10) >= since && !p.foundVia.includes("prices") && (anyQuestion || p.foundBy.some((id) => newsIds.includes(id))),
  );
}

/**
 * One story for each news page of the pool: the stories when the group step fails. Social posts are
 * left out, because no model checked that they are about the topic.
 */
export function pageStories(pool: RunItem[]): RunStory[] {
  return pool
    .filter((item) => item.source === "web" || item.source === "news" || item.source === "papers" || item.source === "company")
    .map((item, i) => ({ key: `r${i + 1}`, laneId: item.laneId, title: item.title, summary: "", items: [item] }));
}

function titleEmphasis(title: string, wanted: string | undefined): string {
  const word = (w: string) => w.replace(/[^\p{L}\p{N}-]/gu, "").toLowerCase();
  const emphasis = word(wanted ?? "");
  return emphasis && title.split(/\s+/).some((w) => word(w) === emphasis) ? emphasis : "";
}

/** Make a Research report about `topic`. Throws `ResearchStepError`. */
export async function makeResearchReport(projectRoot: string, topic: string, deps: MakeDeps = {}): Promise<StoredReport> {
  const clean = topic.trim();
  if (!clean) throw new ResearchStepError("plan", "the topic is empty");
  const roots = deps.roots ?? resolveReportRoots(projectRoot);
  if (!roots) throw new ResearchStepError("store", "the box has no owner files folder");
  const now = (deps.now ?? (() => new Date()))();
  const requestedAt = now.toISOString();
  const anchor = deps.day ? undefined : getOwnerTimeAnchor(projectRoot, now);
  const day = deps.day ?? anchor!.localDate;
  const timezone = anchor?.timezone ?? "UTC";
  const llm = { ...deps.llm, projectRoot };

  const exa = deps.exa === undefined ? exaClient(projectRoot) : deps.exa;
  const webProvider: WebProvider = deps.webProvider ?? "exa";
  // With You.com the search goes through the content router; Exa only reads the full text, when the box has a key.
  let webClient: ExaClient;
  if (webProvider === "you.com") {
    const you = deps.you === undefined ? youClient(projectRoot, exa) : deps.you ? { client: deps.you } : { client: null, reason: "content router off" };
    if (!you.client) throw new ResearchStepError("search", `You.com web search needs the content router, and this box cannot call it (${you.reason})`);
    webClient = you.client;
  } else {
    if (!exa) throw new ResearchStepError("search", "the box has no Exa key for web search");
    webClient = exa;
  }

  const request = cleanRequest(deps.request);
  const planned = await planResearch(clean, day, Date.now() + STEP_LIMITS_MS.plan, llm, request);
  const chosen = deps.sources ? new Set(deps.sources) : null;
  // A source that the owner did not choose makes no search: no Scholar query, no company step.
  const plan = chosen
    ? {
        ...planned,
        subQuestions: planned.subQuestions.map((q) => (chosen.has("papers") ? q : { ...q, scholarQuery: undefined })),
        ...(chosen.has("company") ? {} : { company: undefined }),
      }
    : planned;
  const socialDeps: SocialDeps = { projectRoot, ...deps.socialDeps, llm, ...(request?.hints ? { hints: request.hints } : {}) };
  const goals = reportGoals(plan, chosen, socialDeps);
  // The social posts are searched in parallel with the web; a failure only leaves them out.
  const socialDeadline = Date.now() + STEP_LIMITS_MS.social;
  const socialRun = (deps.social ?? ((_t, q, d, g) => collectSocialPool(q, d, socialDeadline, { ...socialDeps, goals: g })))(
    clean,
    plan.socialQuery ?? clean,
    day,
    goals,
  ).catch(() => null);
  const composio = deps.composio === undefined ? composioSearchClient(projectRoot) : deps.composio;
  const web = await searchWeb(webClient, plan, day, Date.now() + STEP_LIMITS_MS.search, composio);
  const social = await socialRun;
  const sources: SourceState[] = [
    {
      name: "web",
      label: webSourceLabel(webProvider),
      state: web.pages.some((p) => p.foundVia.includes("web")) ? "returned items" : "returned no items",
      engineStatus: web.failed ? `${web.failed} of ${web.total} searches failed` : "ok",
    },
    ...web.extraSources,
    ...(social ? social.sources : [{ name: "social", label: "Social posts", state: "could not be reached" as const, engineStatus: "error" }]),
  ];

  // The news pages and the social posts of the last 30 days become stories (one lane, all new).
  const run = runId(now, timezone);
  const lane: Lane = {
    id: "l1",
    topic: clean,
    addedAt: requestedAt,
    plan: {
      picks: [],
      reason: "",
      webQueries: [],
      newsQuery: "",
      socialQuery: "",
      scholarQuery: "",
      ...(plan.about ? { about: plan.about } : {}),
      ...(plan.notAbout?.length ? { notAbout: plan.notAbout } : {}),
      madeAt: requestedAt,
    },
  };
  const pool = [...newsPages(plan, web.pages, periodStart(day, SOCIAL_WINDOW_DAYS)).map(pageItem), ...(social?.posts ?? []).map(postItem)].map((item, i): RunItem => ({ ...item, key: `n${i + 1}` }));
  const grouped = pool.length
    ? await groupStories([lane], pool, Date.now() + STEP_LIMITS_MS.group, llm, request?.notes ?? "").catch((err: Error) => {
        // Without stories the report would have no news themes, so each dated news page is a story.
        console.warn(`[research] group step failed for "${clean}", each news page becomes a story: ${err.message}`);
        return pageStories(pool);
      })
    : [];
  const { stories } = await compareStories(grouped, { schemaVersion: 1, nextNumber: 1, stories: [] }, { lanes: [lane], startingLanes: new Set(["l1"]), run, now, deadline: Date.now() + STEP_LIMITS_MS.group, llm });

  const sections = plan.subQuestions.filter((q) => q.section);
  const built = await buildThemes({
    mode: "report",
    topic: clean,
    plan,
    notes: request?.notes ?? "",
    stories,
    ...(sections.length ? { sections } : { background: plan.subQuestions.filter((q) => q.kind !== "news") }),
    pages: web.pages,
    exa,
    limits: THEME_LIMITS,
    llm,
  });
  const facts = built.facts;
  const research: Research = { topic: clean, collectedAt: requestedAt, day, plan, ...(request ? { request } : {}), pages: built.pages, facts, social: [], sources };
  const cover = built.summary;
  const title = cover.title || clean.charAt(0).toUpperCase() + clean.slice(1);
  const text: ReportText = {
    quiet: built.quiet,
    summary: cover.chat,
    title,
    titleEmphasis: titleEmphasis(title, cover.titleEmphasis),
    deck: cover.deck || limitSentences(cover.chat, 1),
    oneSentence: cover.oneSentence || limitSentences(cover.chat, 1),
    overview: cover.summary,
    keyFindings: [],
    themes: built.themes,
    // The ideas follow "ask me to", so a capital first letter of a common word goes ("Compare" becomes "compare").
    followUps: (cover.followUps ?? []).map((f) => (/^[A-Z][a-z]/.test(f) ? f.charAt(0).toLowerCase() + f.slice(1) : f)),
    model: deps.llm?.model ?? researchModel(),
    dropped: built.dropped,
  };

  const renderDeadline = Date.now() + STEP_LIMITS_MS.render;
  const id = newReportId(roots, clean, day);
  const pictures: Map<number, Picture> = await pickPictures(text.themes, facts, research.pages, deps.pictureFetch).catch(() => new Map());
  let html: string;
  try {
    const identity = deps.identity ?? (await reportIdentity(projectRoot, deps.pictureFetch));
    html = renderReportHtml({
      research,
      text,
      pictures,
      companionName: identity.companionName,
      ownerDisplayName: identity.ownerDisplayName,
      portrait: identity.portrait,
      fontCss: embeddedFontCss(),
      reportId: id,
    });
  } catch (err) {
    throw err instanceof ResearchStepError ? err : new ResearchStepError("render", (err as Error).message);
  }

  const data: ReportData = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id,
    topic: clean,
    requestedAt,
    research,
    text,
    pictures: [...pictures.entries()].map(([section, p]) => ({ section, pageUrl: p.pageUrl, site: p.site, alt: p.alt })),
  };
  try {
    return await saveReport(
      roots,
      data,
      html,
      deps.writePdf ?? ((h, p) => renderPdf(h, p, { timeoutMs: Math.max(5000, renderDeadline - Date.now()) })),
      reportStories(research, text.themes, run, requestedAt),
    );
  } catch (err) {
    throw err instanceof ResearchStepError ? err : new ResearchStepError("store", (err as Error).message);
  }
}
