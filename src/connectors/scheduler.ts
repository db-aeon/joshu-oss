/**
 * Joshu-native scheduler for connector sync jobs (no Hermes gateway).
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { isComposioEnabled } from "../composioApi.js";
import { isNylasConfigured } from "../nylas/config.js";
import { readAgentGrant } from "../nylas/store.js";
import { joshuConfigDir } from "../nylas/paths.js";
import { isAnyGoogleCalendarConnected } from "./composio/calendarAccounts.js";
import { isAnyGmailConnected } from "./composio/gmailAccounts.js";
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
  // Write a temporary file and rename it, so that a reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ jobs }, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

let cronFileQueue: Promise<unknown> = Promise.resolve();

/**
 * Re-reads connectors-cron.json and changes one job with `apply`, so that a run does not overwrite
 * edits made while it ran (for example `enabled: false` set by an operator).
 * Writes from this process wait for each other.
 */
function updateConnectorCronJob(
  projectRoot: string,
  jobId: string,
  apply: (job: ConnectorCronJob) => void,
): Promise<ConnectorCronJob | undefined> {
  const update = cronFileQueue.then(async () => {
    const jobs = await readConnectorCronJobs(projectRoot);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return undefined;
    apply(job);
    await writeConnectorCronJobs(projectRoot, jobs);
    return job;
  });
  cronFileQueue = update.catch(() => undefined);
  return update;
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

/** Skip cron work when Connectors would show nothing connected for that lane. */
async function connectorCronJobEligible(
  projectRoot: string,
  job: ConnectorCronJob,
): Promise<{ eligible: boolean; reason?: string }> {
  if (job.action === "sync_nylas") {
    if (!isNylasConfigured()) {
      return { eligible: false, reason: "Nylas not configured" };
    }
    if (!readAgentGrant(projectRoot)) {
      return { eligible: false, reason: "No Nylas agent mailbox provisioned" };
    }
    return { eligible: true };
  }

  if (job.action === "sync_composio_gmail") {
    if (!isComposioEnabled()) {
      return { eligible: false, reason: "Composio not enabled" };
    }
    const gmail = await isAnyGmailConnected(projectRoot);
    const calendar = await isAnyGoogleCalendarConnected(projectRoot);
    if (!gmail && !calendar) {
      return { eligible: false, reason: "No Gmail or Google Calendar accounts connected" };
    }
    return { eligible: true };
  }

  return { eligible: false, reason: "unknown action" };
}

/** Runs the sync of one job. Returns the error text, or undefined when the run passed. */
async function runJob(projectRoot: string, job: ConnectorCronJob): Promise<string | undefined> {
  const eligibility = await connectorCronJobEligible(projectRoot, job);
  if (!eligibility.eligible) {
    // Nothing connected for this lane — do not call external APIs or log as an error.
    return undefined;
  }
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
    return undefined;
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[connectors-cron] job ${job.id}: ${lastError}`);
    return lastError;
  }
}

export type ConnectorCronRunner = (projectRoot: string, job: ConnectorCronJob) => Promise<string | undefined>;

/** Ids of the jobs that run now in this process. A job runs at most one time at a time. */
const runningJobIds = new Set<string>();

/**
 * Runs one job unless it already runs. Saves lastRunAt when the job starts, so that later ticks do
 * not find the job due while it runs, and saves lastError when the job ends.
 * Returns undefined when the job already runs.
 */
async function runJobOnce(
  projectRoot: string,
  job: ConnectorCronJob,
  runner: ConnectorCronRunner,
): Promise<ConnectorCronJob | undefined> {
  if (runningJobIds.has(job.id)) {
    console.info(`[connectors-cron] job ${job.id} skip: the previous run has not ended`);
    return undefined;
  }
  runningJobIds.add(job.id);
  const persistFailed = (err: Error) => {
    console.warn(`[connectors-cron] persist failed: ${err.message}`);
    return undefined;
  };
  try {
    const lastRunAt = new Date().toISOString();
    await updateConnectorCronJob(projectRoot, job.id, (j) => {
      j.lastRunAt = lastRunAt;
    }).catch(persistFailed);
    console.info(`[connectors-cron] job ${job.id} start`);
    const lastError = await runner(projectRoot, job);
    console.info(
      `[connectors-cron] job ${job.id} end after ${Math.round((Date.now() - Date.parse(lastRunAt)) / 1000)} s`,
    );
    const saved = await updateConnectorCronJob(projectRoot, job.id, (j) => {
      if (lastError) j.lastError = lastError;
      else delete j.lastError;
    }).catch(persistFailed);
    return saved ?? { ...job, lastRunAt, lastError };
  } finally {
    runningJobIds.delete(job.id);
  }
}

/** One scheduler tick: starts each job that is due and does not run already. */
export async function tickConnectorCron(
  projectRoot: string,
  runner: ConnectorCronRunner = runJob,
): Promise<void> {
  for (const { id } of await readConnectorCronJobs(projectRoot)) {
    // Read the job again: an earlier job of this tick can run for minutes, and the operator can
    // turn this job off in that time.
    const job = (await readConnectorCronJobs(projectRoot)).find((j) => j.id === id);
    if (!job || !jobDue(job, Date.now())) continue;
    await runJobOnce(projectRoot, job, runner);
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

export function startConnectorScheduler(projectRoot: string): void {
  if (tickTimer) return;
  const tickMs = 60_000;

  const tick = () =>
    tickConnectorCron(projectRoot).catch((err) => {
      console.warn(`[connectors-cron] tick failed: ${(err as Error).message}`);
    });

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
  const job = (await readConnectorCronJobs(projectRoot)).find((j) => j.id === jobId);
  if (!job) return { ok: false, error: "job not found" };
  const ran = await runJobOnce(projectRoot, job, runJob);
  if (!ran) return { ok: false, job, error: "job already runs" };
  return { ok: !ran.lastError, job: ran, error: ran.lastError };
}
