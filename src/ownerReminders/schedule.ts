/**
 * Schedule rules of owner reminders (spec owner-reminders). The forms are a
 * subset of the Hermes cron schedule forms, so Hermes parses each accepted value.
 */

export const MIN_INTERVAL_MINUTES = 60;
export const DEFAULT_RECURRING_DAYS = 30;
export const MAX_DURATION_DAYS = 180;

export type ScheduleCheck =
  | { ok: true; kind: "recurring" | "one_time"; schedule: string }
  | { ok: false; error: string };

const DURATION = /^(\d+)\s*(m|h|d)$/i;
const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440 };

function durationMinutes(raw: string): number | null {
  const match = raw.trim().match(DURATION);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) * UNIT_MINUTES[match[2]!.toLowerCase()]!;
}

/** Validate one schedule value and tell if it recurs. */
export function checkReminderSchedule(raw: unknown): ScheduleCheck {
  const schedule = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!schedule) return { ok: false, error: "schedule is required" };

  if (/^every /i.test(schedule)) {
    const minutes = durationMinutes(schedule.slice(6));
    if (minutes === null) return { ok: false, error: `invalid interval "${schedule}" (use every 2h or every 1d)` };
    if (minutes < MIN_INTERVAL_MINUTES) {
      return { ok: false, error: "an owner reminder runs at most once each hour" };
    }
    return { ok: true, kind: "recurring", schedule };
  }

  const fields = schedule.split(" ");
  if (fields.length === 5 && fields.every((f) => /^[\d*\-,/]+$/.test(f))) {
    if (!/^\d+$/.test(fields[0]!)) {
      return { ok: false, error: "an owner reminder runs at most once each hour (minute field must be one number)" };
    }
    return { ok: true, kind: "recurring", schedule };
  }

  if (durationMinutes(schedule) !== null) return { ok: true, kind: "one_time", schedule };

  if (/^\d{4}-\d{2}-\d{2}/.test(schedule) && !Number.isNaN(Date.parse(schedule))) {
    return { ok: true, kind: "one_time", schedule };
  }

  return {
    ok: false,
    error: `invalid schedule "${schedule}" (use a cron expression, "every 1d", "2h", or 2026-10-08T09:00)`,
  };
}

/** End time of a recurring owner reminder: the given one, or now + 30 days. */
export function resolveEndsAt(
  raw: unknown,
  kind: "recurring" | "one_time",
  now: Date,
): { ok: true; endsAt?: string } | { ok: false; error: string } {
  const given = typeof raw === "string" ? raw.trim() : "";
  const maxMs = now.getTime() + MAX_DURATION_DAYS * 86_400_000;
  if (given) {
    const ms = Date.parse(given);
    if (Number.isNaN(ms)) return { ok: false, error: `invalid endsAt "${given}"` };
    if (ms <= now.getTime()) return { ok: false, error: "endsAt must be in the future" };
    if (ms > maxMs) return { ok: false, error: `endsAt must be at most ${MAX_DURATION_DAYS} days from now` };
    return { ok: true, endsAt: new Date(ms).toISOString() };
  }
  if (kind === "one_time") return { ok: true };
  return { ok: true, endsAt: new Date(now.getTime() + DEFAULT_RECURRING_DAYS * 86_400_000).toISOString() };
}
