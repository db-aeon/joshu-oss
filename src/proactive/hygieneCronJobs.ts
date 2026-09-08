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

function buildHygienePrompt(draft: OnboardingDraft): string {
  const owner = draft.ownerName?.trim() || "the owner";
  return (
    `Use skill ${PROACTIVE_HYGIENE_SKILL}. Hygiene mode for ${owner}. ` +
    `skill_view('${PROACTIVE_HYGIENE_SKILL}') — review up to 20 oldest/most date-stale blocked Kanban cards. ` +
    `Auto-complete high-confidence stale cards; do not nudge owner for ambiguous ones in this pass. ` +
    `Update .joshu/proactive/state.json hygiene fields via REST if exposed, or comment counts on cards.`
  );
}

async function listJobs(): Promise<CronBridgeJobSummary[]> {
  const result = await callCronBridge({ action: "list", include_disabled: true });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron list failed");
  }
  return Array.isArray(result.jobs) ? result.jobs : [];
}

/** Idempotent install of daily proactive hygiene cron (Hermes agent). */
export async function syncProactiveHygieneCron(
  draft: OnboardingDraft,
): Promise<"created" | "updated" | "skipped"> {
  const schedule = proactiveHygieneCronSchedule(draft);
  const payload = {
    schedule,
    name: PROACTIVE_HYGIENE_CRON_JOB_NAME,
    prompt: buildHygienePrompt(draft),
    deliver: "local",
    skills: [PROACTIVE_HYGIENE_SKILL],
  };

  const existing = await listJobs();
  const match = existing.find((j) => j.name === PROACTIVE_HYGIENE_CRON_JOB_NAME);
  if (match?.job_id) {
    const alreadyInstalled =
      match.schedule === schedule &&
      match.enabled !== false &&
      (match.skills?.includes(PROACTIVE_HYGIENE_SKILL) ?? true);
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
