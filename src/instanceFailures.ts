/**
 * Background-work failure summary for /api/instance/health → instance-agent heartbeat →
 * control plane daily digest. Reports what silently broke: Kanban worker runs that
 * crashed / timed out / gave up, Hermes cron jobs whose last run or delivery errored, and
 * undeliverable cron jobs.
 * Informational only — never affects `healthy` / `readyForUpdate`.
 */
import fs from "node:fs";
import path from "node:path";

import { cronJobUndeliverableReason } from "./cronDelivery.js";
import { hermesHome, listKanbanBoardSlugs } from "./proactive/boards.js";

/** Kanban run outcomes that mean the worker failed (not `blocked`, which is usually deliberate). */
export const FAILED_RUN_OUTCOMES = ["crashed", "timed_out", "gave_up"] as const;

const WINDOW_HOURS = 24;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 20;
const MAX_ERROR_CHARS = 200;

export type KanbanFailure = {
  board: string;
  taskId: string;
  /** Current task status, e.g. `blocked` when Hermes gave up after failure_limit. */
  taskStatus: string;
  outcome: string;
  failedRuns: number;
  lastFailedAt: string;
  error: string;
};

export type CronFailure = {
  jobId: string;
  name: string;
  lastStatus: string;
  lastRunAt: string | null;
  /** Next scheduled run, so a weekly job that failed 5 days ago reads as "next run Friday". */
  nextRunAt: string | null;
  error: string;
  deliveryError: string;
};

export type FailureReport = {
  ok: boolean;
  checkedAt: string;
  windowHours: number;
  kanban: KanbanFailure[];
  cron: CronFailure[];
  /** True when either list was cut at MAX_ITEMS. */
  truncated: boolean;
  /** Set when a scan step itself failed (report may be partial). */
  scanError?: string;
};

type SqliteStatement = { all: (...params: unknown[]) => Record<string, unknown>[] };
type SqliteDb = { prepare: (sql: string) => SqliteStatement; close: () => void };
type SqliteModule = { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDb };

function clip(value: unknown, max = MAX_ERROR_CHARS): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function epochToIso(raw: unknown): string {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : "";
}

async function loadSqlite(): Promise<SqliteModule> {
  // Variable specifier: @types/node 20 has no node:sqlite typings; runtime is Node 22.
  const spec = "node:sqlite";
  return (await import(spec)) as SqliteModule;
}

export async function scanKanbanFailures(opts: {
  boardsDir: string;
  boards: string[];
  sinceEpochSec: number;
}): Promise<KanbanFailure[]> {
  const { DatabaseSync } = await loadSqlite();
  const placeholders = FAILED_RUN_OUTCOMES.map(() => "?").join(", ");
  const sql = `
    SELECT r.task_id AS task_id, t.status AS task_status, r.outcome AS outcome,
           COUNT(*) AS failed_runs, MAX(r.ended_at) AS last_failed_at,
           (SELECT r2.error FROM task_runs r2
             WHERE r2.task_id = r.task_id AND r2.outcome IN (${placeholders})
             ORDER BY r2.ended_at DESC LIMIT 1) AS error
      FROM task_runs r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.outcome IN (${placeholders}) AND r.ended_at >= ?
     GROUP BY r.task_id
     ORDER BY last_failed_at DESC`;
  const out: KanbanFailure[] = [];
  for (const board of opts.boards) {
    const dbPath = path.join(opts.boardsDir, board, "kanban.db");
    if (!fs.existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(sql)
        .all(...FAILED_RUN_OUTCOMES, ...FAILED_RUN_OUTCOMES, opts.sinceEpochSec);
      for (const row of rows) {
        out.push({
          board,
          taskId: String(row.task_id ?? ""),
          taskStatus: String(row.task_status ?? "unknown"),
          outcome: String(row.outcome ?? ""),
          failedRuns: Number(row.failed_runs ?? 0),
          lastFailedAt: epochToIso(row.last_failed_at),
          error: clip(row.error),
        });
      }
    } finally {
      db.close();
    }
  }
  return out.sort((a, b) => b.lastFailedAt.localeCompare(a.lastFailedAt));
}

/**
 * Cron jobs that silently fail: enabled jobs whose last run errored (incl. drift-guard
 * skips) or whose delivery failed, completed one-time jobs whose run errored, and
 * enabled undeliverable cron jobs (last status `undeliverable`).
 */
export function scanCronFailures(jobsJson: unknown): CronFailure[] {
  const root = jobsJson as { jobs?: unknown } | unknown[] | null;
  const jobs = Array.isArray(root) ? root : Array.isArray(root?.jobs) ? root.jobs : [];
  const out: CronFailure[] = [];
  for (const raw of jobs) {
    if (!raw || typeof raw !== "object") continue;
    const job = raw as Record<string, unknown>;
    // Hermes disables a one-time job after its run (state `completed`); keep its error visible.
    if (job.enabled === false && job.state !== "completed") continue;
    const lastStatus = typeof job.last_status === "string" ? job.last_status : "";
    const deliveryError = clip(job.last_delivery_error);
    const undeliverable = cronJobUndeliverableReason(job);
    if (lastStatus !== "error" && !deliveryError && !undeliverable) continue;
    out.push({
      jobId: String(job.id ?? ""),
      name: clip(job.name, 80),
      lastStatus: undeliverable ? "undeliverable" : lastStatus || "unknown",
      lastRunAt: typeof job.last_run_at === "string" ? job.last_run_at : null,
      nextRunAt: typeof job.next_run_at === "string" ? job.next_run_at : null,
      error: undeliverable ? clip(undeliverable) : lastStatus === "error" ? clip(job.last_error) : "",
      deliveryError,
    });
  }
  return out;
}

export async function buildFailureReport(now = new Date()): Promise<FailureReport> {
  const home = hermesHome();
  const errors: string[] = [];
  let kanban: KanbanFailure[] = [];
  let cron: CronFailure[] = [];

  try {
    kanban = await scanKanbanFailures({
      boardsDir: path.join(home, "kanban", "boards"),
      boards: listKanbanBoardSlugs(),
      sinceEpochSec: Math.floor(now.getTime() / 1000) - WINDOW_HOURS * 3600,
    });
  } catch (err) {
    errors.push(`kanban: ${(err as Error).message}`);
  }

  const jobsPath = path.join(home, "cron", "jobs.json");
  try {
    if (fs.existsSync(jobsPath)) {
      cron = scanCronFailures(JSON.parse(fs.readFileSync(jobsPath, "utf8")));
    }
  } catch (err) {
    errors.push(`cron: ${(err as Error).message}`);
  }

  const truncated = kanban.length > MAX_ITEMS || cron.length > MAX_ITEMS;
  return {
    ok: kanban.length === 0 && cron.length === 0 && errors.length === 0,
    checkedAt: now.toISOString(),
    windowHours: WINDOW_HOURS,
    kanban: kanban.slice(0, MAX_ITEMS),
    cron: cron.slice(0, MAX_ITEMS),
    truncated,
    ...(errors.length ? { scanError: clip(errors.join("; "), 400) } : {}),
  };
}

let cached: { at: number; report: FailureReport } | null = null;
let inflight: Promise<FailureReport> | null = null;

/** Cached for 10 min — /api/instance/health is polled every 30s by the instance agent. */
export async function getFailureReport(): Promise<FailureReport> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;
  if (!inflight) {
    inflight = buildFailureReport()
      .then((report) => {
        cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
