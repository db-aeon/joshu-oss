/**
 * Owner-local clock anchor for Hermes turns and calendar tool output.
 * Prevents UTC/server-date confusion when the model says "today" or "tomorrow".
 */
import { Temporal } from "@js-temporal/polyfill";
import { isValidIanaTimezone, normalizeIanaTimezone } from "./ianaTimezone.js";
import { readAgentProfile } from "./nylas/profile.js";

export type OwnerTimeAnchor = {
  timezone: string;
  isoUtc: string;
  localDate: string;
  localTime: string;
  weekday: string;
  formatted: string;
};

export type RelativeDayLabel = "today" | "tomorrow" | "yesterday";

const DEFAULT_OWNER_TIMEZONE = "America/Los_Angeles";

/** Resolve owner IANA timezone from Nylas profile, with Joshu default fallback. */
export function resolveOwnerTimezone(projectRoot = process.cwd()): string {
  const profile = readAgentProfile(projectRoot);
  const tz = profile?.timezone?.trim();
  if (tz && isValidIanaTimezone(tz)) return normalizeIanaTimezone(tz);
  return DEFAULT_OWNER_TIMEZONE;
}

function formatLocalClock(zoned: Temporal.ZonedDateTime): { localTime: string; displayTime: string } {
  const hour = zoned.hour;
  const minute = zoned.minute;
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return {
    localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    displayTime: `${hour12}:${String(minute).padStart(2, "0")} ${ampm}`,
  };
}

/** Authoritative owner-local moment for temporal grounding. */
export function getOwnerTimeAnchor(projectRoot = process.cwd(), now = new Date()): OwnerTimeAnchor {
  const timezone = normalizeIanaTimezone(resolveOwnerTimezone(projectRoot));
  const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  const zoned = instant.toZonedDateTimeISO(timezone);
  const weekday = zoned.toLocaleString("en-US", { weekday: "long" });
  const { localTime, displayTime } = formatLocalClock(zoned);
  const localDate = zoned.toPlainDate().toString();

  return {
    timezone,
    isoUtc: instant.toString(),
    localDate,
    localTime,
    weekday,
    formatted: `${weekday} ${localDate}, ${displayTime} (${timezone})`,
  };
}

/** Map a calendar local date to today/tomorrow/yesterday relative to the anchor. */
export function relativeDayLabel(
  eventLocalDate: string,
  anchor: OwnerTimeAnchor,
): RelativeDayLabel | null {
  let event: Temporal.PlainDate;
  let today: Temporal.PlainDate;
  try {
    event = Temporal.PlainDate.from(eventLocalDate);
    today = Temporal.PlainDate.from(anchor.localDate);
  } catch {
    return null;
  }

  const diffDays = today.until(event, { largestUnit: "day" }).days;
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  return null;
}

/** Extract YYYY-MM-DD for an event start in the query timezone. */
export function eventLocalDate(start: string | undefined, timezone: string): string | undefined {
  if (!start?.trim()) return undefined;
  const value = start.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  try {
    return Temporal.ZonedDateTime.from(value).toPlainDate().toString();
  } catch {
    try {
      return Temporal.Instant.from(value).toZonedDateTimeISO(timezone).toPlainDate().toString();
    } catch {
      return undefined;
    }
  }
}

export type CalendarEventTimeFields = {
  localDate?: string;
  relativeDay?: RelativeDayLabel | null;
};

export function enrichCalendarEventsWithTimeContext<T extends { start?: string }>(
  events: T[],
  timezone: string,
  anchor: OwnerTimeAnchor,
): Array<T & CalendarEventTimeFields> {
  return events.map((event) => {
    const localDate = eventLocalDate(event.start, timezone);
    if (!localDate) return event;
    return {
      ...event,
      localDate,
      relativeDay: relativeDayLabel(localDate, anchor),
    };
  });
}

export function buildOwnerTimeAnchorPayload(anchor: OwnerTimeAnchor) {
  return {
    timezone: anchor.timezone,
    nowUtc: anchor.isoUtc,
    ownerLocalDate: anchor.localDate,
    ownerLocalWeekday: anchor.weekday,
    ownerLocalTime: anchor.localTime,
    formatted: anchor.formatted,
  };
}

/** Per-turn Hermes system message — inject before user messages on every Joshu-hosted chat turn. */
export function buildOwnerTimeSystemMessage(projectRoot = process.cwd(), now = new Date()): {
  role: "system";
  content: string;
} {
  const anchor = getOwnerTimeAnchor(projectRoot, now);
  const lines = [
    "Current moment for the owner (authoritative — use for today/tomorrow/this week; not UTC server time or Composio time_info):",
    anchor.formatted,
    `Owner calendar date: ${anchor.localDate} (${anchor.weekday}).`,
    "Before saying today, tomorrow, yesterday, or this week in natural language, compare event dates to this anchor.",
    "Do not infer today from the first date in a calendar query window or from UTC timestamps alone.",
    "When calendar tools return relativeDay on events, prefer that over guessing.",
  ];
  return { role: "system", content: lines.join("\n") };
}
