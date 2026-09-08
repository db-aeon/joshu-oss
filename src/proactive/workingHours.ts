import { Temporal } from "@js-temporal/polyfill";

import { normalizeIanaTimezone } from "../ianaTimezone.js";
import type { NylasAgentProfile } from "../nylas/profile.js";
import type { ProactivePreferences } from "./types.js";

const DEFAULT_START = "08:00";
const DEFAULT_END = "17:00";

/** Parse HH:MM into minutes since midnight; null if invalid. */
export function parseMinutesSinceMidnight(time: string | undefined): number | null {
  const match = (time ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function resolveWorkingHours(profile: NylasAgentProfile | null): {
  start: string;
  end: string;
  startMinutes: number;
  endMinutes: number;
} {
  const start = profile?.workingHoursStart?.trim() || DEFAULT_START;
  const end = profile?.workingHoursEnd?.trim() || DEFAULT_END;
  return {
    start,
    end,
    startMinutes: parseMinutesSinceMidnight(start) ?? 8 * 60,
    endMinutes: parseMinutesSinceMidnight(end) ?? 17 * 60,
  };
}

export type ProactiveWindowCheck = {
  ok: boolean;
  reason?: string;
  isWeekend?: boolean;
  isEvening?: boolean;
  localTime?: string;
};

/**
 * Whether proactive nudges may fire now (owner timezone).
 * Default: weekdays within [workingHoursStart, workingHoursEnd).
 */
export function isWithinProactiveWindow(
  profile: NylasAgentProfile | null,
  preferences: ProactivePreferences,
  instant = Temporal.Now.instant(),
): ProactiveWindowCheck {
  const tzRaw = profile?.timezone?.trim();
  if (!tzRaw) {
    return { ok: false, reason: "missing_timezone" };
  }
  const tz = normalizeIanaTimezone(tzRaw);
  const zdt = instant.toZonedDateTimeISO(tz);
  const dayOfWeek = zdt.dayOfWeek; // 1=Mon … 7=Sun
  const isWeekend = dayOfWeek === 6 || dayOfWeek === 7;
  const localMinutes = zdt.hour * 60 + zdt.minute;
  const localTime = `${String(zdt.hour).padStart(2, "0")}:${String(zdt.minute).padStart(2, "0")}`;
  const { startMinutes, endMinutes } = resolveWorkingHours(profile);

  if (isWeekend) {
    if (preferences.allowWeekends) {
      return { ok: true, isWeekend: true, localTime };
    }
    return { ok: false, reason: "weekend_disabled", isWeekend: true, localTime };
  }

  const withinCore = localMinutes >= startMinutes && localMinutes < endMinutes;
  if (withinCore) {
    return { ok: true, isWeekend: false, isEvening: false, localTime };
  }

  const isEvening = localMinutes >= endMinutes;
  if (isEvening && preferences.allowEvenings) {
    return { ok: true, isWeekend: false, isEvening: true, localTime };
  }

  if (localMinutes < startMinutes) {
    return { ok: false, reason: "before_working_hours", isWeekend: false, localTime };
  }
  return { ok: false, reason: "after_working_hours", isWeekend: false, isEvening: true, localTime };
}
