/**
 * A report update against an earlier Research report (design decision D8): one lane from the topic
 * and the sources of the Research report, the period since the report (or since its last report
 * update), its stored stories, and the steps of a run. The report update is saved in
 * `<files>/Research/<report identifier>/updates/<YYYY-MM-DD-HHMM>/`. The companion waits for the
 * result and answers on the channel of the request.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveOwnerTimezone } from "../../ownerLocalTime.js";
import { ResearchStepError } from "../errors.js";
import { reportFolder, type ReportData, type ReportRoots } from "../store.js";
import { goalOfSource } from "../../contentRouter/goals.js";
import { readStoriesFile, readUpdates, writeStoriesFile } from "./store.js";
import { dayLabel, makeUpdate, runId, saveUpdate, type RunDeps } from "./run.js";
import { applyRun, reportStories } from "./stories.js";
import type { Lane, ReportChannel, ResearchSourceId } from "./types.js";

/** A repeat request must answer within 10 minutes (spec `research-report-updates`). */
export const REPEAT_LIMIT_MS = 10 * 60_000;

export type RepeatResult = {
  /** The identifier of the report update: its folder under `<files>/Research/`. */
  updateId: string;
  reportId: string;
  topic: string;
  since: string;
  /** The report update as text for the channel (summary, themes, and links), or empty when nothing is new. */
  digest: string;
  newStories: number;
  developingStories: number;
  sources: { name: string; state: string }[];
};

/** The lane of a Research report: its topic and the queries of its plan. */
export function reportLane(data: ReportData): { lane: Lane; sources: ResearchSourceId[] } {
  const plan = data.research.plan;
  const scholar = plan.subQuestions.find((q) => q.scholarQuery)?.scholarQuery ?? "";
  // The social sources of the report: the default goal ids and the `goal:` ids (change content-router).
  const social = data.research.sources.map((s) => s.name).filter((n) => goalOfSource(n) !== null);
  const sources: ResearchSourceId[] = ["web", ...(scholar ? (["papers"] as const) : []), ...(plan.company ? (["company"] as const) : []), ...social];
  return {
    lane: {
      id: "l1",
      topic: data.topic,
      addedAt: data.requestedAt,
      firstRunAt: data.requestedAt,
      plan: {
        picks: sources,
        reason: "",
        webQueries: plan.subQuestions.slice(0, 2).map((q) => q.recentQuery),
        newsQuery: data.topic,
        socialQuery: plan.socialQuery ?? data.topic,
        scholarQuery: scholar,
        ...(plan.extraGoals?.length ? { extraGoals: plan.extraGoals } : {}),
        ...(plan.company ? { company: plan.company } : {}),
        // What the topic means and what it is not, from the plan of the Research report (D14).
        ...(plan.about ? { about: plan.about } : {}),
        ...(plan.notAbout?.length ? { notAbout: plan.notAbout } : {}),
        // The search terms of the Research report (change research-keyword-expansion).
        ...(plan.namedTerms || plan.expandedTerms ? { namedTerms: plan.namedTerms ?? [], expandedTerms: plan.expandedTerms ?? [] } : {}),
        madeAt: data.requestedAt,
      },
    },
    sources,
  };
}

/** Make a report update against the Research report `reportId`. Throws `ResearchStepError`. */
export async function makeRepeatUpdate(roots: ReportRoots, reportId: string, channel: ReportChannel, deps: RunDeps): Promise<RepeatResult> {
  const folder = reportFolder(roots, reportId);
  if (!folder || !fs.existsSync(path.join(folder, "report.json"))) throw new ResearchStepError("store", `unknown Research report ${reportId}`);
  const data = JSON.parse(fs.readFileSync(path.join(folder, "report.json"), "utf8")) as ReportData;
  const storiesPath = path.join(folder, "stories.json");
  const now = deps.now();
  const timezone = deps.timezone ?? resolveOwnerTimezone(deps.projectRoot);
  const run = runId(now, timezone);
  // A Research report from before recurring reports has no stories.json: make it from report.json.
  const stories = fs.existsSync(storiesPath) ? readStoriesFile(storiesPath) : reportStories(data.research, data.text.themes, data.id, data.requestedAt);
  const since = readUpdates(folder)[0]?.period.to ?? data.requestedAt;
  const { lane, sources } = reportLane(data);

  const made = await makeUpdate(
    {
      name: data.topic,
      kind: "repeat",
      parentId: reportId,
      lanes: [lane],
      sources,
      fromMs: () => Date.parse(since),
      startingLanes: new Set(),
      stories,
      notes: "",
      channel,
    },
    run,
    deps,
  );
  const updateFolder = path.join(folder, "updates", run);
  saveUpdate(updateFolder, made.update, dayLabel(now, timezone), made.pictures);
  writeStoriesFile(storiesPath, applyRun(stories, made.compare, { run, now, shown: new Set(made.shown) }));
  const shown = made.update.stories.filter((s) => s.status !== "quiet");
  return {
    updateId: `${reportId}/updates/${run}`,
    reportId,
    topic: data.topic,
    since,
    digest: made.text ?? "",
    newStories: shown.filter((s) => s.status === "new").length,
    developingStories: shown.filter((s) => s.status === "developing").length,
    sources: made.update.sources.map((s) => ({ name: s.label, state: s.state })),
  };
}
