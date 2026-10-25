/**
 * Cron delivery target checks (openspec/glossary.md "Undeliverable cron job").
 * On a box, the Hermes gateway pushes only to Telegram and Slack: Joshu turns off
 * the Hermes SMS platform, and the api_server adapter cannot send a message that the
 * Hermes gateway starts. The Hermes plugin joshu-realtime-goals repeats these rules
 * in Python (cron_guard.py) to block bad `cronjob` calls; keep both in step.
 */

/** Platforms whose Hermes adapters can push a message on a box. */
export const HERMES_PUSH_PLATFORMS: ReadonlySet<string> = new Set(["telegram", "slack"]);

/** Same normalization as Hermes `_normalize_deliver_value`: empty → "local", list → comma string. */
export function normalizeDeliver(deliver: unknown): string {
  if (deliver === null || deliver === undefined || deliver === "") return "local";
  if (Array.isArray(deliver)) {
    const parts = deliver.map((p) => String(p).trim()).filter(Boolean);
    return parts.length ? parts.join(",") : "local";
  }
  return String(deliver);
}

/**
 * Why a cron delivery target cannot reach anyone, or null when each part can
 * (or may) deliver. `originPlatform` is the platform of the session that made the job.
 */
export function undeliverableReason(deliver: unknown, originPlatform: string | null | undefined): string | null {
  const origin = (originPlatform ?? "").trim().toLowerCase();
  for (const raw of normalizeDeliver(deliver).split(",")) {
    const part = raw.trim().toLowerCase();
    if (!part || part === "local" || part === "all") continue;
    if (part === "origin") {
      if (origin === "api_server") {
        return "deliver=origin goes to an api_server session, which cannot receive cron output";
      }
      continue;
    }
    const platform = part.split(":")[0] ?? "";
    if (!HERMES_PUSH_PLATFORMS.has(platform)) {
      return `deliver=${raw.trim()} names platform "${platform}", which the Hermes gateway does not run on this box`;
    }
  }
  return null;
}

type CronJobLike = Record<string, unknown>;

function originPlatformOf(job: CronJobLike): string | undefined {
  const origin = job.origin;
  if (!origin || typeof origin !== "object") return undefined;
  const platform = (origin as Record<string, unknown>).platform;
  return typeof platform === "string" ? platform : undefined;
}

/** Undeliverable reason for an enabled job of jobs.json; null for a paused job. */
export function cronJobUndeliverableReason(job: CronJobLike): string | null {
  if (job.enabled === false) return null;
  return undeliverableReason(job.deliver, originPlatformOf(job));
}

/** Script name prefix of owner reminder jobs (src/ownerReminders/service.ts). */
const OWNER_REMINDER_SCRIPT = /^owner-reminder-/;

/** Enabled job that looks like a reminder (name or prompt) and is not an owner reminder. */
export function isUnmanagedReminderJob(job: CronJobLike): boolean {
  if (job.enabled === false) return false;
  const script = typeof job.script === "string" ? job.script : "";
  if (OWNER_REMINDER_SCRIPT.test(script.split("/").pop() ?? "")) return false;
  const text = `${typeof job.name === "string" ? job.name : ""}\n${typeof job.prompt === "string" ? job.prompt : ""}`;
  return /remind/i.test(text);
}
