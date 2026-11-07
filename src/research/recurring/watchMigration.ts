/**
 * The Watch migration (design decision D11): at the first boot of this release, before the cleanup
 * of last30days, the watched topics of the last30days app become one recurring report "Watched
 * topics". The schedule and the channel come from the custom Hermes cron job that sent the owner the
 * Watch results, when the box has one. One model call turns the prompt of that job into notes on
 * content and format. Each found Hermes cron job is copied to `migration/` of the recurring report,
 * and the custom jobs are removed; `retireLast30days` then removes the two Watch jobs as before. A
 * marker file makes sure that the migration runs once.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { callCronBridge, type CronBridgeJobSummary, type CronBridgePayload, type CronBridgeResult } from "../../hermesCronBridge.js";
import { joshuConfigDir } from "../../nylas/paths.js";
import { ownerTextChannelFor } from "../../ownerTextChannel.js";
import { hermesHome } from "../../proactive/boards.js";
import { callJson, type JsonCallOpts } from "../pipeline/llm.js";
import { LAST30DAYS_WATCH_CRON_NAMES } from "../retireLast30days.js";
import { boxSenders } from "./delivery.js";
import { recurringRuntime } from "./runtime.js";
import { checkSchedule } from "./schedule.js";
import type { RecurringService } from "./service.js";
import type { ReportChannel } from "./types.js";

export const WATCH_REPORT_NAME = "Watched topics";
const DAILY_WATCH_JOB = LAST30DAYS_WATCH_CRON_NAMES[0];
const DEFAULT_SCHEDULE = "0 8 * * *";
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export type WatchTopic = { name: string; queries: string[] };

export type WatchMigrationDeps = {
  /** The `.joshu` folder of the owner. */
  joshuDir: string;
  /** The Hermes scripts folder, for the copies of the scripts of the removed jobs. */
  scriptsDir: string;
  service: RecurringService;
  cron: (payload: CronBridgePayload) => Promise<CronBridgeResult>;
  /** The owner email addresses of the box profile. */
  profileEmails: () => string[];
  /** The channel of the owner text channel, or null when the box has none. */
  ownerTextChannel: () => "sms" | "email" | null;
  now: () => Date;
  llm?: Pick<JsonCallOpts, "fetchImpl" | "apiKey" | "model" | "projectRoot">;
};

export type WatchMigrationResult = { ran: boolean; reportId?: string; topics: number; copied: string[]; removed: string[]; error?: string };

export function migrationMarkerPath(joshuDir: string): string {
  return path.join(joshuDir, "research", "watch-migration.json");
}

/** The research.db of the engine: `share/` since 2026-09, `memory/` before. */
export function watchDbPath(joshuDir: string): string | null {
  for (const sub of ["share", "memory"]) {
    const file = path.join(joshuDir, "last30days", sub, "research.db");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

type SqliteDb = { prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void };

/** The enabled watched topics, read only. `node:sqlite` is in Node 22; the Node 20 types do not have it. */
export function readWatchTopics(dbPath: string): WatchTopic[] {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (file: string, opts: { readOnly: boolean }) => SqliteDb };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT name, search_queries FROM topics WHERE enabled = 1 ORDER BY id")
      .all()
      .map((row) => ({ name: String(row.name ?? "").trim(), queries: parseQueries(row.search_queries) }))
      .filter((t) => t.name);
  } finally {
    db.close();
  }
}

function parseQueries(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((q): q is string => typeof q === "string" && Boolean(q.trim())).map((q) => q.trim());
  } catch {
    /* a plain list */
  }
  return raw.split(/[\n,]/).map((q) => q.trim()).filter(Boolean);
}

function scheduleOf(job: CronBridgeJobSummary): string {
  return typeof job.schedule === "string" ? job.schedule : (job.schedule?.expr ?? "");
}

/** The Hermes cron jobs that read the Watch results: the two Watch jobs, and custom jobs. */
export function findWatchJobs(jobs: CronBridgeJobSummary[]): { watch: CronBridgeJobSummary[]; custom: CronBridgeJobSummary[] } {
  const watch = jobs.filter((j) => (LAST30DAYS_WATCH_CRON_NAMES as readonly string[]).includes(j.name ?? ""));
  const custom = jobs.filter(
    (j) => !watch.includes(j) && ((j.script ?? "").startsWith("last30days-") || `${j.prompt ?? ""} ${j.script ?? ""}`.includes("/api/last30days/")),
  );
  return { watch, custom };
}

function sendsMail(job: CronBridgeJobSummary): boolean {
  return (job.skills ?? []).some((s) => /nylas|mail/i.test(s)) || /nylas_send|send (an |one )?e-?mail|email/i.test(job.prompt ?? "");
}

const NOTES_SYSTEM = `You turn the instructions of an old scheduled job into notes for a news digest. The digest system already collects the news, groups it into stories, and sends it.
Return JSON only: {"notes": string}
Rules:
- Keep only what the owner wants in the content and the format: the number of items, the order and names of the parts, headings, a line on why each item matters and for whom, plain text, and similar rules.
- Leave out email addresses, recipients, tool names, mailbox names, subjects, dates, time zones, budgets, and instructions on how to send.
- Plain sentences, at most 80 words.`;

/** Notes on content and format from the prompt of a custom job. Never throws; an empty string on failure. */
export async function notesFromPrompt(prompt: string, deadline: number, llm: WatchMigrationDeps["llm"] = {}): Promise<string> {
  if (!prompt.trim()) return "";
  try {
    const { value } = await callJson<string>({
      ...llm,
      step: "plan",
      system: NOTES_SYSTEM,
      user: prompt.slice(0, 6000),
      deadline,
      maxTokens: 400,
      check: (raw) => {
        const notes = raw && typeof raw === "object" ? (raw as { notes?: unknown }).notes : undefined;
        return typeof notes === "string" ? notes : null;
      },
    });
    // The box never keeps a recipient in the notes, even when the model leaves one in.
    return value.replace(EMAIL, "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Run the Watch migration once. Never throws. */
export async function migrateWatch(deps: WatchMigrationDeps): Promise<WatchMigrationResult> {
  const marker = migrationMarkerPath(deps.joshuDir);
  const none = (extra: Partial<WatchMigrationResult> = {}): WatchMigrationResult => ({ ran: false, topics: 0, copied: [], removed: [], ...extra });
  if (fs.existsSync(marker)) return none();
  try {
    const db = watchDbPath(deps.joshuDir);
    const topics = db ? readWatchTopics(db) : [];
    if (!topics.length) {
      writeJson(marker, { ranAt: deps.now().toISOString(), topics: 0 });
      return { ...none(), ran: true };
    }

    const listed = await deps.cron({ action: "list", include_disabled: true });
    if (!listed.success) return none({ error: String(listed.error ?? "cron list failed") });
    // The list shows a short prompt only; the detail of each job has the whole prompt and the script.
    const details: CronBridgeJobSummary[] = [];
    for (const job of Array.isArray(listed.jobs) ? listed.jobs : []) {
      if (!job.job_id) continue;
      const got = await deps.cron({ action: "get", job_id: job.job_id }).catch(() => ({ success: false }) as CronBridgeResult);
      details.push(got.success && got.job ? (got.job as CronBridgeJobSummary) : job);
    }
    const { watch, custom } = findWatchJobs(details);
    // The earliest custom job decides the schedule and the channel.
    const first = [...custom].sort((a, b) => String((a as { created_at?: string }).created_at ?? "").localeCompare(String((b as { created_at?: string }).created_at ?? "")))[0];
    const daily = watch.find((j) => j.name === DAILY_WATCH_JOB);
    const wanted = first ? scheduleOf(first) : daily ? scheduleOf(daily) : DEFAULT_SCHEDULE;
    const schedule = checkSchedule(wanted).ok ? wanted : DEFAULT_SCHEDULE;
    const text = deps.ownerTextChannel();
    const channel: ReportChannel = first && sendsMail(first) ? "email" : text === "email" ? "email" : "sms";
    // Recipients only from the addresses in the prompt that are owner addresses of the box profile.
    const profile = new Set(deps.profileEmails().map((e) => e.toLowerCase()));
    const emailTo = channel === "email" && first ? [...new Set((first.prompt ?? "").match(EMAIL) ?? [])].filter((e) => profile.has(e.toLowerCase())) : [];
    const notes = first ? await notesFromPrompt(first.prompt ?? "", Date.now() + 60_000, deps.llm) : "";

    const saved = await deps.service.save({
      name: WATCH_REPORT_NAME,
      topics: topics.map((t) => ({ topic: t.name, ...(t.queries.length ? { hints: t.queries } : {}) })),
      schedule,
      sources: "auto",
      channel,
      notes,
      ...(emailTo.length ? { emailTo } : {}),
      origin: "watch-migration",
    });
    if (saved.status >= 300) return none({ error: String(saved.body.error ?? "the recurring report was not made") });
    const reportId = String((saved.body.report as { id: string }).id);
    const setup = deps.service.store.get(reportId)!;
    const migrationDir = path.join(deps.service.store.folder(setup), "migration");

    const copied: string[] = [];
    for (const job of [...custom, ...watch]) {
      writeJson(path.join(migrationDir, `${job.job_id}.json`), job);
      copied.push(job.job_id ?? "");
      const script = job.script ? path.join(deps.scriptsDir, path.basename(job.script)) : "";
      if (script && fs.existsSync(script)) fs.copyFileSync(script, path.join(migrationDir, path.basename(script)));
    }
    const removed: string[] = [];
    for (const job of custom) {
      const out = await deps.cron({ action: "remove", job_id: job.job_id }).catch((e: Error) => ({ success: false, error: e.message }) as CronBridgeResult);
      if (out.success) removed.push(job.job_id ?? "");
      else console.warn(`[research-recurring] Watch migration could not remove job ${job.job_id}: ${out.error}`);
    }
    writeJson(marker, { ranAt: deps.now().toISOString(), reportId, topics: topics.length, schedule, channel, copied, removed });
    console.info(`[research-recurring] Watch migration made ${reportId} with ${topics.length} parts; removed ${removed.length} custom jobs`);
    return { ran: true, reportId, topics: topics.length, copied, removed };
  } catch (err) {
    return none({ error: (err as Error).message });
  }
}

/** The Watch migration of this box, with the production dependencies. Never throws. */
export async function migrateWatchOnBox(projectRoot: string): Promise<WatchMigrationResult | null> {
  const joshuDir = joshuConfigDir(projectRoot);
  const runtime = recurringRuntime(projectRoot);
  if (!joshuDir || !runtime) return null;
  return migrateWatch({
    joshuDir,
    scriptsDir: path.join(hermesHome(), "scripts"),
    service: runtime.service,
    cron: callCronBridge,
    profileEmails: () => boxSenders(projectRoot).profileEmails().map((p) => p.email),
    ownerTextChannel: () => ownerTextChannelFor(projectRoot),
    now: () => new Date(),
    llm: { projectRoot },
  });
}
