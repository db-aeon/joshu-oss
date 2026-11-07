/**
 * The recurring report service (design decisions D1, D2, D13): make, change, pause, resume, delete,
 * and list recurring reports. The plugin tools, the routes of the Research app, the Hermes cron job
 * script, and the Watch migration all call this one service, so chat and the app always change the
 * same recurring report. Each active recurring report has one Hermes cron job with `no_agent: true`
 * whose script calls `POST /joshu/api/research/recurring/<id>/run`, in the way of owner reminders.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { callCronBridge, type CronBridgePayload, type CronBridgeResult } from "../../hermesCronBridge.js";
import { hermesHome } from "../../proactive/boards.js";
import { resolveReportRoots } from "../store.js";
import { MAX_GOAL_SOURCES } from "../../contentRouter/goals.js";
import { cleanHints } from "../pipeline/plan.js";
import { availableSources, laneSources, planLanes, withWebAndNews, type PlanLlm } from "./plan.js";
import { buildSchedule, checkSchedule, describeSchedule, scheduleDays, scheduleTimes } from "./schedule.js";
import { CHANNEL_LABELS, readUpdates, RECURRING_DIR_NAME, RecurringStore } from "./store.js";
import {
  REPORT_CHANNELS,
  researchSourceLabel,
  type Lane,
  type RecurringSetup,
  type ReportChannel,
  type ResearchSourceId,
} from "./types.js";

export const RECURRING_JOB_PREFIX = "Research: ";
export const RECURRING_SCRIPT_PREFIX = "research-recurring-";
const PLAN_TIME_MS = 60_000;

export type RecurringDeps = {
  projectRoot: string;
  store: RecurringStore;
  /** Hermes scripts directory (~/.hermes/scripts). */
  scriptsDir: string;
  cron: (payload: CronBridgePayload) => Promise<CronBridgeResult>;
  now: () => Date;
  /** The sources that this box can use (design decision D2). */
  available: () => ResearchSourceId[];
  llm?: PlanLlm;
};

export type RecurringSaveInput = {
  /** Set to change an existing recurring report. */
  id?: unknown;
  name?: unknown;
  /** The full list of topics: strings, or `{topic, hints}`. */
  topics?: unknown;
  /** Days (names or numbers, 0 is Sunday) and times (`07:00`), or a cron expression in `schedule`. */
  days?: unknown;
  times?: unknown;
  schedule?: unknown;
  /** `auto`, or the full list of sources. */
  sources?: unknown;
  /** Hints that the companion took from its skills (change content-router, D8), for example "Polymarket for prediction market odds". */
  hints?: unknown;
  channel?: unknown;
  notes?: unknown;
  /** True when the owner wants a short message on a run with nothing new. */
  nothingNewLine?: unknown;
  /** For email: owner addresses of the box profile (the Watch migration sets them). */
  emailTo?: unknown;
  origin?: RecurringSetup["origin"];
};

/** HTTP-shaped result: the routes send `body` with `status`. */
export type RecurringResult = { status: number; body: Record<string, unknown> };

/** What the companion and the Research app show about one recurring report. */
export type RecurringView = {
  id: string;
  name: string;
  state: RecurringSetup["state"];
  quiet: boolean;
  schedule: string;
  scheduleText: string;
  channel: ReportChannel;
  channelText: string;
  sources: "auto" | ResearchSourceId[];
  notes: string;
  lanes: { id: string; topic: string; sources: string[]; reason?: string }[];
  lastRun?: RecurringSetup["lastRun"];
  /** The identifier of the last report update, for `research_update_pdf`. */
  lastUpdateId?: string;
  nextRunAt?: string;
  folder: string;
};

/** The Research app marks a recurring report quiet after this many runs in a row with nothing new. */
export const QUIET_AFTER_RUNS = 5;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const SOURCE_WORDS: Record<string, ResearchSourceId> = {
  web: "web",
  news: "web",
  "web and news": "web",
  papers: "papers",
  "research papers": "papers",
  scholar: "papers",
  "google scholar": "papers",
  company: "company",
  "company data": "company",
  stocks: "company",
  reddit: "reddit",
  x: "x",
  twitter: "x",
  youtube: "youtube",
  tiktok: "tiktok",
  instagram: "instagram",
};

/**
 * `auto`, or a list of sources with Web and news first. A `goal:` source names a content goal, for
 * example `goal:prediction market odds` (change content-router). Null when a value is unknown, or
 * when the list has more than five `goal:` sources, because each goal costs money on each run.
 */
export function parseSources(raw: unknown): "auto" | ResearchSourceId[] | null {
  if (raw === undefined || raw === null || str(raw).toLowerCase() === "auto") return "auto";
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!list) return null;
  const ids: ResearchSourceId[] = [];
  for (const item of list) {
    const word = str(item).toLowerCase().replace(/\s+/g, " ");
    const id = SOURCE_WORDS[word] ?? (word.startsWith("goal:") && word.length > 5 && word.length <= 65 ? word.replace(/^goal:\s*/, "goal:") : undefined);
    if (!id) return null;
    ids.push(id);
  }
  const sources = withWebAndNews(ids);
  if (sources.filter((s) => s.startsWith("goal:")).length > MAX_GOAL_SOURCES) return null;
  return sources;
}

/** The answer to a list of sources that `parseSources` refused. */
export const SOURCES_ERROR = `unknown source, or more than ${MAX_GOAL_SOURCES} goal: sources; use auto or a list of: web, papers, company, reddit, x, youtube, tiktok, instagram, and at most ${MAX_GOAL_SOURCES} of goal:<kind of source>`;

/** The hints of a save input: a list of short texts, or undefined when the input has none. */
export function parseHints(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return cleanHints(Array.isArray(raw) ? raw.map(str) : typeof raw === "string" ? raw.split("\n") : []);
}

const CHANNEL_WORDS: Record<string, ReportChannel> = { email: "email", sms: "sms", text: "sms", "text message": "sms", slack: "slack", telegram: "telegram" };

export function parseChannel(raw: unknown): ReportChannel | null {
  return CHANNEL_WORDS[str(raw).toLowerCase()] ?? null;
}

function parseTopics(raw: unknown): { topic: string; hints?: string[] }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { topic: string; hints?: string[] }[] = [];
  for (const item of raw) {
    const topic = typeof item === "string" ? item.trim() : str((item as { topic?: unknown })?.topic);
    if (!topic) continue;
    const hints = Array.isArray((item as { hints?: unknown })?.hints) ? ((item as { hints: unknown[] }).hints.map(str).filter(Boolean)) : [];
    if (!out.some((t) => t.topic.toLowerCase() === topic.toLowerCase())) out.push({ topic, ...(hints.length ? { hints } : {}) });
  }
  return out;
}

/** "Humanoid robots", or "Humanoid robots and defense robotics contracts", or "A, B, and 2 more". */
export function defaultName(topics: string[]): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (topics.length <= 2) return cap(topics.join(" and "));
  return cap(`${topics.slice(0, 2).join(", ")}, and ${topics.length - 2} more`);
}

/** Script that Hermes runs for one recurring report (Hermes passes no arguments). */
export function recurringScript(id: string): string {
  return `#!/usr/bin/env bash
# Recurring report ${id} (Joshu). Generated file; Joshu deletes it when the recurring report is deleted.
set -uo pipefail
PORT="\${JOSHU_API_PORT:-8788}"
BASE="\${JOSHU_API_BASE:-http://127.0.0.1:\${PORT}/joshu}"
out="$(curl -sS -X POST "\${BASE}/api/research/recurring/${id}/run" -H "Content-Type: application/json" -d '{}' -w '\\n%{http_code}')" || {
  echo "recurring report ${id}: Joshu API unreachable" >&2
  exit 1
}
code="\${out##*$'\\n'}"
body="\${out%$'\\n'*}"
if [[ "\${code}" != 2* ]]; then
  echo "recurring report ${id}: HTTP \${code} \${body}" >&2
  exit 1
fi
echo "\${body}"
`;
}

export class RecurringService {
  constructor(readonly deps: RecurringDeps) {}

  get store(): RecurringStore {
    return this.deps.store;
  }

  view(setup: RecurringSetup, nextRunAt?: string): RecurringView {
    return {
      id: setup.id,
      name: setup.name,
      state: setup.state,
      quiet: setup.state === "active" && setup.nothingNewInARow >= QUIET_AFTER_RUNS,
      schedule: setup.schedule,
      scheduleText: describeSchedule(setup.schedule),
      channel: setup.channel,
      channelText: CHANNEL_LABELS[setup.channel],
      sources: setup.sources,
      notes: setup.notes,
      lanes: setup.lanes.map((lane) => ({
        id: lane.id,
        topic: lane.topic,
        sources: laneSources(lane, setup.sources).map((s) => researchSourceLabel(s)),
        ...(setup.sources === "auto" && lane.plan?.reason ? { reason: lane.plan.reason } : {}),
      })),
      ...(setup.lastRun ? { lastRun: setup.lastRun } : {}),
      ...lastUpdate(this.store, setup),
      ...(nextRunAt ? { nextRunAt } : {}),
      folder: path.relative(this.store.roots.filesRoot, this.store.folder(setup)).split(path.sep).join("/"),
    };
  }

  /** Every recurring report that is not deleted, the oldest first. */
  list(): RecurringView[] {
    return this.store.list().filter((s) => s.state !== "deleted").map((s) => this.view(s));
  }

  /** Make a recurring report, or change one when `input.id` is set. */
  async save(input: RecurringSaveInput): Promise<RecurringResult> {
    const id = str(input.id);
    const existing = id ? this.store.get(id) : null;
    if (id && (!existing || existing.state === "deleted")) return { status: 404, body: { ok: false, error: `unknown recurring report ${id}` } };

    const topics = input.topics === undefined && existing ? null : parseTopics(input.topics);
    if (!existing && !topics?.length) return { status: 400, body: { ok: false, error: "topics is required (a list of topics)" } };
    if (topics && !topics.length) return { status: 400, body: { ok: false, error: "a recurring report needs at least one topic" } };

    let schedule = existing?.schedule ?? "";
    if (input.schedule !== undefined) {
      const checked = checkSchedule(input.schedule);
      if (!checked.ok) return { status: 400, body: { ok: false, error: checked.error } };
      schedule = checked.schedule;
    } else if (input.times !== undefined || input.days !== undefined) {
      // "Mondays only" keeps the time, and "at 8 instead" keeps the days.
      const days = input.days !== undefined ? input.days : existing ? scheduleDays(existing.schedule) : undefined;
      const times = input.times !== undefined ? input.times : existing ? scheduleTimes(existing.schedule) : undefined;
      const built = buildSchedule(days, times);
      if (!built.ok) return { status: 400, body: { ok: false, error: built.error } };
      schedule = built.schedule;
    }
    if (!schedule) return { status: 400, body: { ok: false, error: "days and times (or schedule) are required" } };

    const sources = input.sources === undefined ? (existing?.sources ?? "auto") : parseSources(input.sources);
    if (!sources) return { status: 400, body: { ok: false, error: SOURCES_ERROR } };
    // Email is the channel of a new recurring report unless the owner names another one.
    const channel = input.channel === undefined || input.channel === null || input.channel === "" ? (existing?.channel ?? "email") : parseChannel(input.channel);
    if (!channel) return { status: 400, body: { ok: false, error: `unknown channel: use one of ${REPORT_CHANNELS.join(", ")}` } };
    const notes = input.notes === undefined ? (existing?.notes ?? "") : str(input.notes);
    const newHints = parseHints(input.hints);
    const hints = newHints ?? existing?.hints ?? [];
    const hintsChanged = newHints !== undefined && JSON.stringify(newHints) !== JSON.stringify(existing?.hints ?? []);
    const nothingNewLine = typeof input.nothingNewLine === "boolean" ? input.nothingNewLine : existing?.nothingNewLine;
    const emailTo = Array.isArray(input.emailTo) ? input.emailTo.map(str).filter(Boolean) : existing?.emailTo;

    const now = this.deps.now();
    const at = now.toISOString();
    // Keep each lane whose topic did not change, with its plan; a new topic is a new lane.
    const lanes: Lane[] = [];
    const oldLanes = existing?.lanes ?? [];
    let nextLane = Math.max(0, ...oldLanes.map((l) => Number(l.id.slice(1)) || 0)) + 1;
    for (const t of topics ?? oldLanes.map((l) => ({ topic: l.topic, hints: l.hints }))) {
      const kept = oldLanes.find((l) => l.topic.toLowerCase() === t.topic.toLowerCase());
      lanes.push(kept ? { ...kept, ...(t.hints ? { hints: t.hints } : {}) } : { id: `l${nextLane++}`, topic: t.topic, ...(t.hints ? { hints: t.hints } : {}), addedAt: at });
    }
    // Auto picks again for every lane when the owner switches the sources to Auto, and the lanes
    // are planned again when the hints change, because the hints add content goals.
    const repick = (sources === "auto" && existing !== null && existing.sources !== "auto") || hintsChanged;
    const toPlan = lanes.filter((l) => !l.plan || repick);
    if (toPlan.length) {
      const plans = await planLanes(toPlan, {
        available: this.deps.available(),
        pickSources: sources === "auto",
        deadline: Date.now() + PLAN_TIME_MS,
        now,
        llm: { projectRoot: this.deps.projectRoot, ...this.deps.llm },
        notes,
        hints,
      });
      toPlan.forEach((lane, i) => (lane.plan = plans[i]));
    }

    const name = str(input.name) || existing?.name || defaultName(lanes.map((l) => l.topic));
    const extras = { ...(nothingNewLine !== undefined ? { nothingNewLine } : {}), ...(emailTo?.length ? { emailTo } : {}), ...(hints.length || existing?.hints ? { hints } : {}) };
    if (existing) return this.change(existing, { name, lanes, schedule, sources, channel, notes, ...extras });

    const newId = `rr_${randomBytes(4).toString("hex")}`;
    const setup: RecurringSetup = {
      schemaVersion: 1,
      id: newId,
      slug: this.store.newSlug(name),
      name,
      lanes,
      sources,
      schedule,
      channel,
      notes,
      ...extras,
      state: "active",
      scriptName: `${RECURRING_SCRIPT_PREFIX}${newId}.sh`,
      createdAt: at,
      updatedAt: at,
      nothingNewInARow: 0,
      origin: input.origin ?? "chat",
    };
    // Save the folder before the Hermes cron job exists, so a first run always finds it.
    this.store.create(setup);
    const scriptPath = path.join(this.deps.scriptsDir, setup.scriptName);
    let created: CronBridgeResult;
    try {
      await mkdir(this.deps.scriptsDir, { recursive: true });
      await writeFile(scriptPath, recurringScript(newId), { mode: 0o700 });
      await chmod(scriptPath, 0o700);
      created = await this.deps.cron({
        action: "create",
        name: `${RECURRING_JOB_PREFIX}${name}`,
        schedule,
        script: setup.scriptName,
        no_agent: true,
        deliver: "local",
        workdir: this.deps.projectRoot,
      });
    } catch (error) {
      created = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    const jobId = typeof created.job_id === "string" ? created.job_id : "";
    if (!created.success || !jobId) {
      // No Hermes cron job: the recurring report would never run, so it is deleted again.
      await this.store.update(newId, (s) => ((s.state = "deleted"), { result: undefined, changed: true }));
      await rm(scriptPath, { force: true }).catch(() => undefined);
      return { status: 502, body: { ok: false, error: `Hermes cron job not created: ${created.error ?? "unknown error"}` } };
    }
    const saved = await this.store.update(newId, (s) => ((s.cronJobId = jobId), { result: undefined, changed: true }), now);
    console.info(`[research-recurring] created ${newId} job=${jobId} schedule="${schedule}" lanes=${lanes.length}`);
    return { status: 201, body: { ok: true, report: this.view(saved!.setup, nextRunAt(created)) } };
  }

  private async change(
    existing: RecurringSetup,
    next: Pick<RecurringSetup, "name" | "lanes" | "schedule" | "sources" | "channel" | "notes" | "nothingNewLine" | "emailTo" | "hints">,
  ): Promise<RecurringResult> {
    const now = this.deps.now();
    const saved = await this.store.update(existing.id, (s) => {
      Object.assign(s, next);
      return { result: undefined, changed: true };
    }, now);
    let nextRun: string | undefined;
    if (existing.cronJobId && (existing.schedule !== next.schedule || existing.name !== next.name)) {
      const updated = await this.deps.cron({ action: "update", job_id: existing.cronJobId, schedule: next.schedule, name: `${RECURRING_JOB_PREFIX}${next.name}` }).catch((e: Error) => ({ success: false, error: e.message }) as CronBridgeResult);
      if (!updated.success) {
        // Put the old schedule back, so the app and the Hermes cron job show the same schedule.
        await this.store.update(existing.id, (s) => ((s.schedule = existing.schedule), (s.name = existing.name), { result: undefined, changed: true }), now);
        return { status: 502, body: { ok: false, error: `Hermes cron job not changed: ${updated.error ?? "unknown error"}` } };
      }
      nextRun = nextRunAt(updated);
    }
    console.info(`[research-recurring] changed ${existing.id}`);
    return { status: 200, body: { ok: true, report: this.view(this.store.get(existing.id) ?? saved!.setup, nextRun) } };
  }

  /** Pause, resume, or delete. A delete keeps the folder and its report updates. */
  async setState(id: string, action: "pause" | "resume" | "delete"): Promise<RecurringResult> {
    const setup = this.store.get(str(id));
    if (!setup || setup.state === "deleted") return { status: 404, body: { ok: false, error: `unknown recurring report ${id}` } };
    const state = action === "pause" ? "paused" : action === "resume" ? "active" : "deleted";
    let next: string | undefined;
    if (setup.cronJobId) {
      const result = await this.deps
        .cron(action === "delete" ? { action: "remove", job_id: setup.cronJobId } : { action, job_id: setup.cronJobId })
        .catch((e: Error) => ({ success: false, error: e.message }) as CronBridgeResult);
      if (!result.success && !(action === "delete" && /not found/i.test(String(result.error ?? "")))) {
        return { status: 502, body: { ok: false, error: `Hermes cron job not changed: ${result.error ?? "unknown error"}` } };
      }
      next = nextRunAt(result);
    }
    if (action === "delete") await rm(path.join(this.deps.scriptsDir, setup.scriptName), { force: true }).catch(() => undefined);
    const saved = await this.store.update(setup.id, (s) => {
      s.state = state;
      if (action === "delete") delete s.cronJobId;
      return { result: undefined, changed: true };
    }, this.deps.now());
    console.info(`[research-recurring] ${action} ${setup.id}`);
    return { status: 200, body: { ok: true, report: this.view(saved!.setup, next) } };
  }
}

/** The identifier of the newest report update with a digest. */
function lastUpdate(store: RecurringStore, setup: RecurringSetup): { lastUpdateId?: string } {
  const latest = readUpdates(store.folder(setup)).find((u) => u.digest);
  return latest ? { lastUpdateId: `${RECURRING_DIR_NAME}/${setup.slug}/updates/${latest.run}` } : {};
}

function nextRunAt(result: CronBridgeResult): string | undefined {
  const job = result.job as { next_run_at?: unknown } | undefined;
  return typeof job?.next_run_at === "string" ? job.next_run_at : typeof result.next_run_at === "string" ? result.next_run_at : undefined;
}

let defaultService: RecurringService | undefined;

/** Production service, or null when the box has no owner files folder. */
export function recurringService(projectRoot: string): RecurringService | null {
  if (defaultService) return defaultService;
  const roots = resolveReportRoots(projectRoot);
  if (!roots) return null;
  defaultService = new RecurringService({
    projectRoot,
    store: new RecurringStore(roots),
    scriptsDir: path.join(hermesHome(), "scripts"),
    cron: callCronBridge,
    now: () => new Date(),
    available: () => availableSources(projectRoot),
  });
  return defaultService;
}
