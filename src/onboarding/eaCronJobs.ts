/**
 * Install or refresh Executive Assistant Hermes cron windows after Welcome onboarding.
 * EA v2: morning, evening, weekly — no midday. Idempotent by fixed job name.
 */
import { callCronBridge, type CronBridgeJobSummary } from "../hermesCronBridge.js";
import type { OnboardingDraft } from "./types.js";

export const EA_CRON_JOB_NAMES = {
  morning: "EA morning",
  eod: "EA evening",
  weekly: "EA weekly",
} as const;

/** Legacy job removed on sync. */
const LEGACY_MIDDAY_NAME = "EA midday window";

/** Hermes skill-backed cron: must match SKILL.md frontmatter `name`. */
export const EA_PLAYBOOK_SKILL = "ea-playbook";

type EaCronJobSpec = {
  name: string;
  schedule: string;
  prompt: string;
};

function line(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v || fallback;
}

/** Parse "HH:MM" or "H:MM" into minutes since midnight; null if invalid. */
function parseMinutesSinceMidnight(time: string | undefined): number | null {
  const match = (time ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Hermes cron expression: minute hour dom month dow */
function cronAt(minutesSinceMidnight: number, weekdays: string): string {
  const hour = Math.floor(minutesSinceMidnight / 60);
  const minute = minutesSinceMidnight % 60;
  return `${minute} ${hour} * * ${weekdays}`;
}

function buildSchedules(draft: OnboardingDraft): {
  morning: string;
  eod: string;
  weekly: string;
} {
  const start = parseMinutesSinceMidnight(draft.workingHoursStart) ?? 8 * 60;
  const end = parseMinutesSinceMidnight(draft.workingHoursEnd) ?? 17 * 60;

  return {
    morning: cronAt(start, "1-5"),
    eod: cronAt(end, "1-5"),
    weekly: cronAt(start, "5"),
  };
}

function buildJobSpecs(draft: OnboardingDraft): EaCronJobSpec[] {
  const owner = line(draft.ownerName, "Principal");
  const email = line(draft.primaryWorkEmail, "owner Gmail");
  const schedules = buildSchedules(draft);

  const skill = EA_PLAYBOOK_SKILL;
  return [
    {
      name: EA_CRON_JOB_NAMES.morning,
      schedule: schedules.morning,
      prompt:
        `Use skill ${skill}. Morning handoff for ${owner}. ` +
        `skill_view('ea-morning-review') — prep Planning/daily-review-YYYY-MM-DD.md from yesterday's time-block plan, send morning POINTER email via Nylas to ${email} (Projects/_system/summary-email.md). ` +
        `Per-mail ingest mirrors and queues ea-mail-ingress; do not batch-drain Triage.`,
    },
    {
      name: EA_CRON_JOB_NAMES.eod,
      schedule: schedules.eod,
      prompt:
        `Use skill ${skill}. Evening shutdown for ${owner}. ` +
        `skill_view('ea-shutdown') — draft End of day section in Planning/daily-review-YYYY-MM-DD.md. ` +
        `Append project journals for the day. Send evening summary with shutdown pointer via Nylas to ${email}. ` +
        `Do not batch-drain Triage stubs — ingest handles routing.`,
    },
    {
      name: EA_CRON_JOB_NAMES.weekly,
      schedule: schedules.weekly,
      prompt:
        `Use skill ${skill}. Weekly review for ${owner}. ` +
        `Hygiene on Projects/other, archive completed projects, chase todo Waiting on and Blocker. ` +
        `Send weekly summary if useful. Ingest handles new mail routing.`,
    },
  ];
}

async function listExistingJobs(): Promise<CronBridgeJobSummary[]> {
  const result = await callCronBridge({ action: "list", include_disabled: true });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron list failed");
  }
  return Array.isArray(result.jobs) ? result.jobs : [];
}

async function removeLegacyMidday(existing: CronBridgeJobSummary[]): Promise<void> {
  const match = existing.find((j) => j.name === LEGACY_MIDDAY_NAME);
  if (!match?.job_id) return;
  await callCronBridge({ action: "remove", job_id: match.job_id });
  console.info("[ea-cron] removed legacy midday job");
}

async function upsertJob(spec: EaCronJobSpec, existing: CronBridgeJobSummary[]): Promise<"created" | "updated"> {
  const match = existing.find((job) => job.name === spec.name);
  const payload = {
    schedule: spec.schedule,
    name: spec.name,
    prompt: spec.prompt,
    deliver: "local",
    skills: [EA_PLAYBOOK_SKILL],
  };

  if (match?.job_id) {
    const result = await callCronBridge({
      action: "update",
      job_id: match.job_id,
      ...payload,
    });
    if (!result.success) {
      throw new Error(typeof result.error === "string" ? result.error : `update failed for ${spec.name}`);
    }
    return "updated";
  }

  const result = await callCronBridge({
    action: "create",
    ...payload,
  });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : `create failed for ${spec.name}`);
  }
  return "created";
}

export type SyncEaCronJobsResult = {
  ok: boolean;
  created: number;
  updated: number;
  schedules: ReturnType<typeof buildSchedules>;
  error?: string;
};

/** Best-effort sync of EA cron windows from Welcome draft. Does not throw. */
export async function syncEaCronJobs(draft: OnboardingDraft): Promise<SyncEaCronJobsResult> {
  const schedules = buildSchedules(draft);
  try {
    const existing = await listExistingJobs();
    await removeLegacyMidday(existing);
    const specs = buildJobSpecs(draft);
    let created = 0;
    let updated = 0;
    for (const spec of specs) {
      const outcome = await upsertJob(spec, existing);
      if (outcome === "created") created += 1;
      else updated += 1;
    }
    return { ok: true, created, updated, schedules };
  } catch (err) {
    return {
      ok: false,
      created: 0,
      updated: 0,
      schedules,
      error: (err as Error).message,
    };
  }
}
