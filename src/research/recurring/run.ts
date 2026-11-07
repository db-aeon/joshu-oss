/**
 * One run of a recurring report, and the shared steps of every report update (design decisions D3,
 * D4, D6, and D8): collect, group, compare, then the themes of change research-report-topics (sort,
 * read, facts, write and check, summary), then save and send. Each step has a time limit, so a run
 * is done or failed within 12.5 minutes, inside the 15 minutes after its scheduled time (design
 * decision D12 of change research-report-topics). A failed run sends a short failure
 * note, sends no partial report update, and changes neither `stories.json` nor the period of the
 * next run.
 */

import fs from "node:fs";
import path from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { resolveOwnerTimezone } from "../../ownerLocalTime.js";
import { ResearchStepError, type ResearchStep } from "../errors.js";
import type { ComposioSearchClient } from "../pipeline/composioSearch.js";
import type { ExaClient } from "../pipeline/exa.js";
import type { SocialDeps } from "../social/sources.js";
import { collectRun, type CollectPeriod } from "./collect.js";
import { deliver, type DeliveryResult, type DeliverySenders } from "./delivery.js";
import { withDeadline } from "../pipeline/llm.js";
import { pickPictures, type Picture } from "../pipeline/pictures.js";
import { buildThemes, notesThemeLimit, type ThemeLimits } from "../themes/index.js";
import { themesEmailText, themesText } from "../themes/text.js";
import { describeLanes, laneSources } from "./plan.js";
import { RECURRING_DIR_NAME, readStoriesFile, RecurringStore, writeFileAtomic, writeStoriesFile } from "./store.js";
import { renderUpdatePdf, updateIdentity } from "./updatePdf.js";
import type { NylasSendAttachment } from "../../nylas/attachments.js";
import { applyRun, compareStories, groupStories, type CompareResult, type Llm } from "./stories.js";
import type { Lane, RecurringSetup, ReportChannel, ResearchSourceId, RunSummary, StoriesFile, UpdateFile } from "./types.js";

/** Time limits of the steps of a run (design decision D12 of change research-report-topics). */
export const RUN_LIMITS_MS = {
  collect: 120_000,
  group: 90_000,
  compare: 60_000,
  themes: 30_000,
  read: 60_000,
  extract: 75_000,
  write: 105_000,
  summary: 30_000,
  pictures: 30_000,
  render: 90_000,
  send: 60_000,
} as const;

const THEME_LIMITS: ThemeLimits = { themes: RUN_LIMITS_MS.themes, read: RUN_LIMITS_MS.read, extract: RUN_LIMITS_MS.extract, write: RUN_LIMITS_MS.write, summary: RUN_LIMITS_MS.summary };
/** The time limit of the call that says what the topics of old lane plans mean (it runs before the collect step). */
export const MEANING_LIMIT_MS = 30_000;
/** A starting update, and a new lane, cover this many days. */
export const STARTING_DAYS = 7;
const DAY_MS = 86_400_000;

export type RunDeps = {
  projectRoot: string;
  exa: ExaClient | null;
  composio: ComposioSearchClient | null;
  social?: SocialDeps;
  llm?: Llm;
  senders: DeliverySenders;
  now: () => Date;
  /** The owner timezone; default from the box profile. */
  timezone?: string;
  /** The PDF writer of the update PDF; default Chromium (`renderPdf`). Tests pass a fake. */
  writePdf?: (htmlPath: string, pdfPath: string) => Promise<void>;
  /** The download of the pictures of the update PDF; default `fetch`. Tests pass a fake. */
  pictureFetch?: typeof fetch;
};

/** The run identifier: the time of the run in the owner timezone, `YYYY-MM-DD-HHMM`. */
export function runId(now: Date, timezone: string): string {
  const z = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timezone);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${z.year}-${p(z.month)}-${p(z.day)}-${p(z.hour)}${p(z.minute)}`;
}


/** "October 30" in the owner timezone. */
export function dayLabel(now: Date, timezone: string): string {
  return now.toLocaleDateString("en-US", { timeZone: timezone, month: "long", day: "numeric" });
}

function periodFrom(fromMs: number, now: Date): CollectPeriod {
  const from = new Date(fromMs).toISOString();
  return { from, fromDay: from.slice(0, 10), to: now.toISOString(), days: Math.max(1, Math.ceil((now.getTime() - fromMs) / DAY_MS)) };
}

/** Run `fn` with the time limit of `step`. A late step fails with its own name. */
async function step<T>(name: ResearchStep, ms: number, fn: (deadline: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + ms;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ResearchStepError(name, `the ${name} step ran longer than ${Math.round(ms / 1000)} seconds`)), ms);
  });
  try {
    return await Promise.race([fn(deadline), late]);
  } catch (err) {
    throw err instanceof ResearchStepError ? err : new ResearchStepError(name, (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export type UpdateSpec = {
  name: string;
  kind: UpdateFile["kind"];
  parentId: string;
  lanes: Lane[];
  sources: "auto" | ResearchSourceId[];
  /** The start of the period of each lane (epoch milliseconds). */
  fromMs: (lane: Lane) => number;
  startingLanes: Set<string>;
  stories: StoriesFile;
  notes: string;
  channel: ReportChannel;
};

export type UpdateResult = {
  update: UpdateFile;
  compare: CompareResult;
  /** The text of the report update on its channel, or undefined when nothing is new. */
  text?: string;
  /** The identifiers of the stories that the themes show. */
  shown: string[];
  /** The pictures of the themes, for the update PDF. */
  pictures: Map<number, Picture>;
};

/** What the topics of the lanes mean and what they are not, for the theme steps (D14). */
function lanesAbout(lanes: Lane[]): { about?: string; notAbout?: string[] } {
  const about = lanes
    .filter((l) => l.plan?.about)
    .map((l) => (lanes.length > 1 ? `${l.topic}: ${l.plan!.about}` : l.plan!.about!))
    .join(" ");
  const notAbout = [...new Set(lanes.flatMap((l) => l.plan?.notAbout ?? []))];
  return { ...(about ? { about } : {}), ...(notAbout.length ? { notAbout } : {}) };
}

/**
 * The steps of a report update up to the checked text: collect, group, compare, and the themes.
 * Throws `ResearchStepError` with the step that failed.
 */
export async function makeUpdate(spec: UpdateSpec, run: string, deps: RunDeps): Promise<UpdateResult> {
  const now = deps.now();
  const llm = { projectRoot: deps.projectRoot, ...deps.llm };
  const plan = spec.lanes.map((lane) => ({ lane, sources: laneSources(lane, spec.sources), period: periodFrom(spec.fromMs(lane), now) }));
  const collected = await step("collect", RUN_LIMITS_MS.collect, (deadline) => collectRun(plan, deadline, deps));
  const runStories = collected.items.length ? await step("group", RUN_LIMITS_MS.group, (deadline) => groupStories(spec.lanes, collected.items, deadline, llm, spec.notes)) : [];
  const compare = await step("compare", RUN_LIMITS_MS.compare, (deadline) =>
    compareStories(runStories, spec.stories, { lanes: spec.lanes, startingLanes: spec.startingLanes, run, now, deadline, llm }),
  );
  const candidates = compare.stories.filter((s) => s.status !== "quiet");
  const themeTotal = Object.values(THEME_LIMITS).reduce((a, b) => a + b, 0);
  const built = candidates.length
    ? await step("themes", themeTotal, () =>
        buildThemes({
          mode: "update",
          topic: spec.lanes.length === 1 ? spec.lanes[0]!.topic : spec.name,
          plan: lanesAbout(spec.lanes),
          notes: spec.notes,
          stories: candidates,
          ...(notesThemeLimit(spec.notes) ? { limit: notesThemeLimit(spec.notes)! } : {}),
          exa: deps.exa,
          limits: THEME_LIMITS,
          llm,
        }),
      )
    : undefined;
  const pictures = built
    ? await withDeadline(pickPictures(built.themes, built.facts, built.pages, deps.pictureFetch), Date.now() + RUN_LIMITS_MS.pictures).catch(() => new Map<number, Picture>())
    : new Map<number, Picture>();
  const cited = built ? new Set([...built.themes.flatMap((t) => t.factIds), ...[...built.summary.summary.matchAll(/\[(F\d+)\]/g)].map((m) => m[1]!)]) : new Set<string>();
  const facts = built?.facts.filter((f) => cited.has(f.id)) ?? [];
  const pageIds = new Set(facts.map((f) => f.pageId));
  const text = built ? themesText(built.summary.summary, built.themes, spec.channel) : undefined;
  const update: UpdateFile = {
    schemaVersion: 2,
    run,
    name: spec.name,
    kind: spec.kind,
    parentId: spec.parentId,
    period: { from: new Date(Math.min(...spec.lanes.map(spec.fromMs))).toISOString(), to: now.toISOString() },
    lanes: plan.map((p) => ({ id: p.lane.id, topic: p.lane.topic, starting: spec.startingLanes.has(p.lane.id), sources: p.sources })),
    stories: compare.stories,
    sources: collected.sources,
    ...(built
      ? {
          summary: built.summary.summary,
          chat: built.summary.chat,
          themes: built.themes,
          facts,
          pages: built.pages.filter((p) => pageIds.has(p.id)).map((p) => ({ id: p.id, url: p.url, title: p.title, site: p.site, ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}) })),
          digest: { text: text!, channel: spec.channel, dropped: built.dropped },
        }
      : {}),
  };
  const shown = built ? [...new Set(built.themes.flatMap((t) => t.storyIds ?? []))] : [];
  return { update, compare, ...(text ? { text } : {}), shown, pictures };
}

/**
 * `update.md`: the report update as text, with a header that names the report and the date. A
 * report update of version 2 has its themes with their links; one of version 1 has its digest.
 */
export function updateMarkdown(update: UpdateFile, dateText: string): string {
  const sources = update.sources.filter((s) => s.state === "returned items").map((s) => s.label);
  const missed = update.sources.filter((s) => s.state === "could not be reached").map((s) => s.label);
  const body = update.themes?.length ? themesEmailText(update.summary ?? "", update.themes) : (update.digest?.text ?? "Nothing new.");
  return [
    `# ${update.name}: ${dateText}`,
    "",
    body,
    "",
    `Sources: ${sources.join(", ") || "none"}.${missed.length ? ` Could not be reached: ${missed.join(", ")}.` : ""}`,
    "",
  ].join("\n");
}

/** Save `update.json`, `update.md` when the update has text, and `pictures.json` for the update PDF. */
export function saveUpdate(folder: string, update: UpdateFile, dateText: string, pictures?: Map<number, Picture>): void {
  fs.mkdirSync(folder, { recursive: true });
  writeFileAtomic(path.join(folder, "update.json"), `${JSON.stringify(update, null, 2)}\n`);
  if (update.digest) writeFileAtomic(path.join(folder, "update.md"), updateMarkdown(update, dateText));
  if (pictures?.size) writeFileAtomic(path.join(folder, "pictures.json"), `${JSON.stringify(Object.fromEntries(pictures))}\n`);
}

const NOTHING_NEW_WORDS = /nothing new|no news|even (?:if|when) (?:there is|there's) nothing/i;

/** True when the owner asked for a line on a run with nothing new. */
export function wantsNothingNewLine(setup: Pick<RecurringSetup, "nothingNewLine" | "notes">): boolean {
  return setup.nothingNewLine ?? NOTHING_NEW_WORDS.test(setup.notes);
}

/** The failure note of a run (spec: "A failed run sends a short note"). */
export function failureNote(name: string, dateText: string): { subject: string; text: string } {
  return {
    subject: `${name}: update failed`,
    text: `Your report update "${name}" for ${dateText} failed, so I sent nothing today. The next update covers everything since your last one.`,
  };
}

/**
 * The update PDF for an email, attached the way a Research report is attached. A PDF that fails is
 * left out: the owner still gets the digest, and can ask for the full update later.
 */
async function updatePdfAttachment(
  store: RecurringStore,
  setup: RecurringSetup,
  run: string,
  made: UpdateResult,
  dateText: string,
  timezone: string,
  deps: RunDeps,
): Promise<NylasSendAttachment[] | undefined> {
  try {
    saveUpdate(path.join(store.folder(setup), "updates", run), made.update, dateText, made.pictures);
    const updateId = `${RECURRING_DIR_NAME}/${setup.slug}/updates/${run}`;
    const pdf = await step("render", RUN_LIMITS_MS.render, async () =>
      renderUpdatePdf(store.roots, updateId, { dateText, timezone, identity: await updateIdentity(deps.projectRoot, deps.pictureFetch), ...(deps.writePdf ? { writePdf: deps.writePdf } : {}) }),
    );
    const content = fs.readFileSync(pdf.pdfPath);
    return [{ filename: `${setup.slug}-${run}.pdf`, contentType: "application/pdf", content, size: content.length }];
  } catch (err) {
    console.warn(`[research-recurring] update PDF of ${setup.id} ${run} not made, sending the digest without it: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * The lanes of a recurring report, each with what its topic means (D14) and its search terms
 * (change research-keyword-expansion). A lane plan from before D14 or before the search terms, or a
 * fallback plan, misses some of them: one model call fills in only the missing fields, and
 * `setup.json` keeps them. The queries and the sources of the lane plan stay the same. When the call
 * fails, the run goes on with the lanes as they are, and the next run tries again.
 */
export async function withLaneMeaning(store: RecurringStore, setup: RecurringSetup, deps: RunDeps): Promise<Lane[]> {
  const missing = setup.lanes.filter((l) => l.plan && (!l.plan.about || !l.plan.namedTerms));
  if (!missing.length) return setup.lanes;
  const meanings = await describeLanes(missing, { deadline: Date.now() + MEANING_LIMIT_MS, llm: { projectRoot: deps.projectRoot, ...deps.llm }, notes: setup.notes });
  const found = new Map(missing.flatMap((l, i) => (meanings[i]?.about || meanings[i]?.namedTerms ? [[l.id, meanings[i]!] as const] : [])));
  if (!found.size) return setup.lanes;
  const saved = await store.update(setup.id, (s) => {
    for (const lane of s.lanes) {
      const meaning = found.get(lane.id);
      if (!meaning || !lane.plan) continue;
      if (!lane.plan.about && meaning.about) Object.assign(lane.plan, { about: meaning.about, ...(meaning.notAbout ? { notAbout: meaning.notAbout } : {}) });
      if (!lane.plan.namedTerms && meaning.namedTerms) Object.assign(lane.plan, { namedTerms: meaning.namedTerms, expandedTerms: meaning.expandedTerms ?? [] });
    }
    return { result: undefined, changed: true };
  }, deps.now());
  return saved?.setup.lanes ?? setup.lanes;
}

/**
 * Run one recurring report: make the report update, save it, and send it. Returns the summary of the
 * run. Never throws: a failure becomes a failed run with a failure note.
 */
export async function runRecurringReport(store: RecurringStore, id: string, deps: RunDeps): Promise<RunSummary> {
  const setup = store.get(id);
  if (!setup || setup.state !== "active") return { at: deps.now().toISOString(), result: "skipped", error: setup ? setup.state : "unknown" };
  const now = deps.now();
  const timezone = deps.timezone ?? resolveOwnerTimezone(deps.projectRoot);
  const run = runId(now, timezone);
  const dateText = dayLabel(now, timezone);
  const folder = store.folder(setup);
  const updateFolder = path.join(folder, "updates", run);
  const storiesPath = path.join(folder, "stories.json");
  const startingFrom = now.getTime() - STARTING_DAYS * DAY_MS;
  const coveredFrom = Date.parse(setup.lastCoveredAt ?? "") || startingFrom;
  const startingLanes = new Set(setup.lanes.filter((l) => !l.firstRunAt).map((l) => l.id));

  const finish = async (summary: RunSummary, worked: boolean): Promise<RunSummary> => {
    await store.update(id, (s) => {
      s.lastRun = summary;
      delete s.running;
      if (worked) {
        s.lastCoveredAt = now.toISOString();
        for (const lane of s.lanes) lane.firstRunAt ??= now.toISOString();
        if (summary.result === "delivered") {
          s.lastDeliveredAt = now.toISOString();
          s.nothingNewInARow = 0;
        } else s.nothingNewInARow += 1;
      }
      return { result: undefined, changed: true };
    }, now);
    return summary;
  };

  const fail = async (failedStep: string, error: string): Promise<RunSummary> => {
    console.warn(`[research-recurring] run ${id} ${run} failed at ${failedStep}: ${error}`);
    const note = failureNote(setup.name, dateText);
    const sent = await deliver(setup.channel, { ...note, dedupeKey: `${id}:${run}:failed`, emailTo: setup.emailTo }, deps.senders);
    return finish({ at: now.toISOString(), result: "failed", step: failedStep, error, ...(sent.channel ? { channel: sent.channel } : {}) }, false);
  };

  let made: UpdateResult;
  try {
    const lanes = await withLaneMeaning(store, setup, deps);
    made = await makeUpdate(
      {
        name: setup.name,
        kind: "recurring",
        parentId: setup.id,
        lanes,
        sources: setup.sources,
        fromMs: (lane) => (startingLanes.has(lane.id) ? startingFrom : coveredFrom),
        startingLanes,
        stories: readStoriesFile(storiesPath),
        notes: setup.notes,
        channel: setup.channel,
      },
      run,
      deps,
    );
  } catch (err) {
    return fail(err instanceof ResearchStepError ? err.step : "store", (err as Error).message);
  }

  const { update, compare, text } = made;
  const shownIds = new Set(made.shown);
  let sent: DeliveryResult | undefined;
  try {
    if (text) {
      const attachments = setup.channel === "email" ? await updatePdfAttachment(store, setup, run, made, dateText, timezone, deps) : undefined;
      sent = await step("send", RUN_LIMITS_MS.send, async () =>
        deliver(
          setup.channel,
          { subject: `${setup.name}: ${dateText}`, text, ...(attachments ? { attachments } : {}), dedupeKey: `${id}:${run}`, emailTo: setup.emailTo },
          deps.senders,
        ),
      );
      update.delivery = { channel: sent.channel ?? setup.channel, at: deps.now().toISOString(), result: sent.delivered ? "delivered" : "failed", ...(sent.messageId ? { messageId: sent.messageId } : {}), ...(sent.error ? { error: sent.error } : {}) };
      saveUpdate(updateFolder, update, dateText, made.pictures);
      if (!sent.delivered) return fail("send", sent.error ?? "the report update was not delivered");
    } else {
      saveUpdate(updateFolder, update, dateText);
      if (wantsNothingNewLine(setup)) {
        const line = `Nothing new in "${setup.name}" since your last update.`;
        const lineSent = await deliver(setup.channel, { subject: `${setup.name}: nothing new`, text: line, dedupeKey: `${id}:${run}:nothing`, emailTo: setup.emailTo }, deps.senders);
        update.delivery = { channel: lineSent.channel ?? setup.channel, at: deps.now().toISOString(), result: lineSent.delivered ? "delivered" : "failed", ...(lineSent.error ? { error: lineSent.error } : {}) };
        saveUpdate(updateFolder, update, dateText);
      }
    }
    writeStoriesFile(storiesPath, applyRun(readStoriesFile(storiesPath), compare, { run, now, shown: shownIds }));
  } catch (err) {
    return fail(err instanceof ResearchStepError ? err.step : "store", (err as Error).message);
  }

  const relative = path.relative(store.roots.filesRoot, updateFolder).split(path.sep).join("/");
  const summary: RunSummary = text
    ? { at: now.toISOString(), result: "delivered", stories: shownIds.size, channel: sent?.channel ?? setup.channel, folder: relative }
    : { at: now.toISOString(), result: "nothing new", stories: 0, folder: relative };
  console.info(`[research-recurring] run ${id} ${run}: ${summary.result} stories=${summary.stories}`);
  return finish(summary, true);
}

/**
 * Runs in the background with at most two at once on the box (design decision D3). A recurring
 * report that is still running is skipped.
 */
export class RecurringRunner {
  static readonly MAX_AT_ONCE = 2;
  private readonly active = new Set<string>();
  private readonly waiting: string[] = [];

  constructor(
    private readonly store: RecurringStore,
    private readonly deps: () => RunDeps,
  ) {}

  /** Start a run in the background. */
  async trigger(id: string): Promise<"started" | "queued" | "skipped" | "unknown"> {
    const setup = this.store.get(id);
    if (!setup) return "unknown";
    if (setup.state !== "active" || setup.running || this.active.has(id) || this.waiting.includes(id)) return "skipped";
    const now = this.deps().now();
    await this.store.update(id, (s) => ((s.running = { startedAt: now.toISOString(), runId: id }), { result: undefined, changed: true }), now);
    if (this.active.size >= RecurringRunner.MAX_AT_ONCE) {
      this.waiting.push(id);
      return "queued";
    }
    this.start(id);
    return "started";
  }

  /** Resolves when no run is going on or waiting (tests). */
  async idle(): Promise<void> {
    while (this.active.size || this.waiting.length) await new Promise((r) => setTimeout(r, 10));
  }

  private start(id: string): void {
    this.active.add(id);
    void runRecurringReport(this.store, id, this.deps())
      .catch((err) => console.warn(`[research-recurring] run ${id} crashed: ${(err as Error).message}`))
      .finally(async () => {
        await this.store.update(id, (s) => (s.running ? (delete s.running, { result: undefined, changed: true }) : { result: undefined, changed: false }));
        this.active.delete(id);
        const next = this.waiting.shift();
        if (next) this.start(next);
      });
  }

  /**
   * At Joshu start: a run that was left running (a deploy or a crash stopped Joshu) is marked
   * failed, and the owner gets the failure note.
   */
  async recoverInterrupted(): Promise<string[]> {
    const deps = this.deps();
    const out: string[] = [];
    for (const setup of this.store.list().filter((s) => s.running)) {
      const now = deps.now();
      const timezone = deps.timezone ?? resolveOwnerTimezone(deps.projectRoot);
      const note = failureNote(setup.name, dayLabel(new Date(setup.running!.startedAt), timezone));
      const sent = setup.state === "active" ? await deliver(setup.channel, { ...note, dedupeKey: `${setup.id}:${setup.running!.startedAt}:failed`, emailTo: setup.emailTo }, deps.senders) : undefined;
      await this.store.update(setup.id, (s) => {
        delete s.running;
        s.lastRun = { at: now.toISOString(), result: "failed", step: "store", error: "Joshu stopped during the run", ...(sent?.channel ? { channel: sent.channel } : {}) };
        return { result: undefined, changed: true };
      }, now);
      out.push(setup.id);
    }
    return out;
  }
}

