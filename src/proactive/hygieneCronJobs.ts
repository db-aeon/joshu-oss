/**
 * Daily Hermes cron: proactive Kanban hygiene (LLM + gbrain — stale card cleanup).
 */
import { callCronBridge, type CronBridgeJobSummary } from "../hermesCronBridge.js";
import type { OnboardingDraft } from "../onboarding/types.js";

export const PROACTIVE_HYGIENE_CRON_JOB_NAME = "Joshu proactive hygiene";
export const PROACTIVE_HYGIENE_SKILL = "joshu-proactive";

function parseMinutesSinceMidnight(time: string | undefined): number | null {
  const match = (time ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Weekday 10:00 owner TZ (offset from EA morning). */
export function proactiveHygieneCronSchedule(draft: OnboardingDraft): string {
  const start = parseMinutesSinceMidnight(draft.workingHoursStart) ?? 9 * 60;
  const hygieneMinutes = start + 60;
  const hour = Math.floor(hygieneMinutes / 60);
  const minute = hygieneMinutes % 60;
  return `${minute} ${hour} * * 1-5`;
}

export function buildHygienePrompt(draft: OnboardingDraft): string {
  const owner = draft.ownerName?.trim() || "the owner";
  return (
    `Use skill ${PROACTIVE_HYGIENE_SKILL}. Hygiene mode for ${owner}. ` +
    `Step 1: MCP proactive_hygiene_prepare (cross-board blocked scan — do NOT use execute_code, SQLite, or Desktop scripts). ` +
    `Step 2: For each candidate in the plan: kanban_show → gbrain query on source_paths → classify. ` +
    `High confidence stale → kanban_complete + audit comment (cite evidence). ` +
    `Ambiguous → skip auto-close (record in proactive_hygiene_record). Still active → leave blocked. ` +
    `Step 3: proactive_hygiene_record with closedTaskIds, ambiguous[], skipped, active counts. ` +
    `Forbidden: kanban-sqlite.md, execute_code, write_file scripts on Desktop, direct state.json edits.`
  );
}

async function listJobs(): Promise<CronBridgeJobSummary[]> {
  const result = await callCronBridge({ action: "list", include_disabled: true });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron list failed");
  }
  return Array.isArray(result.jobs) ? result.jobs : [];
}

function cronScheduleExpr(schedule: CronBridgeJobSummary["schedule"]): string | null {
  if (typeof schedule === "string") return schedule;
  if (schedule && typeof schedule === "object" && typeof schedule.expr === "string") {
    return schedule.expr;
  }
  return null;
}

/** Idempotent install of daily proactive hygiene cron (Hermes agent). */
export async function syncProactiveHygieneCron(
  draft: OnboardingDraft,
): Promise<"created" | "updated" | "skipped"> {
  const schedule = proactiveHygieneCronSchedule(draft);
  const prompt = buildHygienePrompt(draft);
  const payload = {
    schedule,
    name: PROACTIVE_HYGIENE_CRON_JOB_NAME,
    prompt,
    deliver: "local",
    skills: [PROACTIVE_HYGIENE_SKILL],
  };

  const existing = await listJobs();
  const match = existing.find((j) => j.name === PROACTIVE_HYGIENE_CRON_JOB_NAME);
  if (match?.job_id) {
    const scheduleExpr = cronScheduleExpr(match.schedule);
    const alreadyInstalled =
      scheduleExpr === schedule &&
      match.enabled !== false &&
      (match.skills?.includes(PROACTIVE_HYGIENE_SKILL) ?? true) &&
      match.prompt === prompt;
    if (alreadyInstalled) return "skipped";
    const result = await callCronBridge({ action: "update", job_id: match.job_id, ...payload });
    if (!result.success) {
      throw new Error(typeof result.error === "string" ? result.error : "cron update failed");
    }
    return "updated";
  }

  const result = await callCronBridge({ action: "create", ...payload });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron create failed");
  }
  return "created";
}
