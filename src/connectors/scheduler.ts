/**
 * Joshu-native scheduler for connector sync jobs (no Hermes gateway).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";
import { runMailSync } from "./syncHelpers.js";

export type ConnectorCronJob = {
  id: string;
  name: string;
  schedule: string;
  action: "sync_nylas" | "sync_composio_gmail";
  enabled?: boolean;
  lastRunAt?: string;
  lastError?: string;
};

type CronStore = {
  jobs: ConnectorCronJob[];
};

const DEFAULT_JOBS: ConnectorCronJob[] = [
  { id: "poll-nylas", name: "Poll Nylas agent inbox", schedule: "every 10m", action: "sync_nylas", enabled: true },
  { id: "sync-gmail", name: "Sync owner Gmail mirror", schedule: "every 10m", action: "sync_composio_gmail", enabled: true },
];

function cronPath(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "connectors-cron.json");
}

export async function readConnectorCronJobs(projectRoot: string): Promise<ConnectorCronJob[]> {
  const file = cronPath(projectRoot);
  if (!file) return [...DEFAULT_JOBS];
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CronStore;
    if (Array.isArray(parsed.jobs) && parsed.jobs.length > 0) return parsed.jobs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[connectors-cron] read failed: ${(err as Error).message}`);
    }
  }
  return [...DEFAULT_JOBS];
}

export async function writeConnectorCronJobs(projectRoot: string, jobs: ConnectorCronJob[]): Promise<void> {
  const file = cronPath(projectRoot);
  if (!file) throw new Error("Could not resolve Joshu config dir for connector cron");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ jobs }, null, 2)}\n`, "utf8");
}

/** Parse `every 5m` / `every 2h` into milliseconds. */
export function parseEverySchedule(schedule: string): number | null {
  const m = /^every\s+(\d+)\s*([mhd])$/i.exec(schedule.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  if (unit === "d") return n * 86_400_000;
  return null;
}

function jobDue(job: ConnectorCronJob, nowMs: number): boolean {
  if (job.enabled === false) return false;
  const intervalMs = parseEverySchedule(job.schedule);
  if (intervalMs == null) return false;
  if (!job.lastRunAt) return true;
  const last = Date.parse(job.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMs;
}

async function runJob(projectRoot: string, job: ConnectorCronJob): Promise<ConnectorCronJob> {
  const updated = { ...job, lastRunAt: new Date().toISOString() };
  try {
    if (job.action === "sync_nylas") {
      const r = await runMailSync(projectRoot, "nylas", {
        syncCalendar: true,
        syncMode: "incremental",
      });
      if (!r.ok) throw new Error(r.error || "nylas sync failed");
    } else if (job.action === "sync_composio_gmail") {
      const r = await runMailSync(projectRoot, "gmail", { syncMode: "incremental" });
      if (!r.ok) throw new Error(r.error || "composio sync failed");
    }
    delete updated.lastError;
  } catch (err) {
    updated.lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[connectors-cron] job ${job.id}: ${updated.lastError}`);
  }
  return updated;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

export function startConnectorScheduler(projectRoot: string): void {
  if (tickTimer) return;
  const tickMs = 60_000;

  const tick = async () => {
    const nowMs = Date.now();
    let jobs = await readConnectorCronJobs(projectRoot);
    let changed = false;
    const nextJobs: ConnectorCronJob[] = [];
    for (const job of jobs) {
      if (!jobDue(job, nowMs)) {
        nextJobs.push(job);
        continue;
      }
      const ran = await runJob(projectRoot, job);
      nextJobs.push(ran);
      changed = true;
    }
    if (changed) {
      try {
        await writeConnectorCronJobs(projectRoot, nextJobs);
      } catch (err) {
        console.warn(`[connectors-cron] persist failed: ${(err as Error).message}`);
      }
    }
  };

  void tick();
  tickTimer = setInterval(() => void tick(), tickMs);
  console.log(`[connectors-cron] scheduler started (tick ${tickMs / 1000}s)`);
}

export function stopConnectorScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export async function runConnectorCronJobNow(
  projectRoot: string,
  jobId: string,
): Promise<{ ok: boolean; job?: ConnectorCronJob; error?: string }> {
  const jobs = await readConnectorCronJobs(projectRoot);
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx < 0) return { ok: false, error: "job not found" };
  const ran = await runJob(projectRoot, jobs[idx]!);
  jobs[idx] = ran;
  await writeConnectorCronJobs(projectRoot, jobs);
  return { ok: !ran.lastError, job: ran, error: ran.lastError };
}
