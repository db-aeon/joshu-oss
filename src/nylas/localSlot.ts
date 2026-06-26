import { Temporal } from "@js-temporal/polyfill";
import { isValidIanaTimezone, normalizeIanaTimezone } from "../ianaTimezone.js";

export type LocalSlotInput = {
  date?: string;
  startLocal?: string;
  endLocal?: string;
  /** snake_case aliases from MCP / REST */
  start_local?: string;
  end_local?: string;
  startTimeLocal?: string;
  endTimeLocal?: string;
  timezone?: string;
  timeZone?: string;
  startTime?: number;
  endTime?: number;
  /** list_events query aliases */
  start?: number;
  end?: number;
};

export type ResolvedEventWindow = {
  startTime: number;
  endTime: number;
  timezone?: string;
  /** Present when conversion used local slot fields */
  resolvedFrom?: "local_slot" | "epoch";
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseDateParts(date: string): { year: number; month: number; day: number } {
  const match = DATE_RE.exec(date.trim());
  if (!match) {
    throw new Error(`invalid date "${date}" — use YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const plain = Temporal.PlainDate.from({ year, month, day });
  if (plain.year !== year || plain.month !== month || plain.day !== day) {
    throw new Error(`invalid calendar date "${date}"`);
  }
  return { year, month, day };
}

function parseTimeParts(time: string): { hour: number; minute: number; second: number } {
  const match = TIME_RE.exec(time.trim());
  if (!match) {
    throw new Error(`invalid local time "${time}" — use HH:mm or HH:mm:ss`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`invalid local time "${time}"`);
  }
  return { hour, minute, second };
}

function readTimezone(input: LocalSlotInput): string {
  const tz = readString(input.timezone) || readString(input.timeZone);
  if (!tz) throw new Error("timezone is required for local slot input");
  const normalized = normalizeIanaTimezone(tz);
  if (!isValidIanaTimezone(normalized)) {
    throw new Error(`invalid IANA timezone "${tz}"`);
  }
  return normalized;
}

function readLocalTime(input: LocalSlotInput, kind: "start" | "end"): string {
  const value =
    kind === "start"
      ? readString(input.startLocal) ||
        readString(input.start_local) ||
        readString(input.startTimeLocal)
      : readString(input.endLocal) ||
        readString(input.end_local) ||
        readString(input.endTimeLocal);
  if (!value) {
    throw new Error(kind === "start" ? "startLocal is required" : "endLocal is required");
  }
  return value;
}

/** Convert local wall-clock date/time in an IANA zone to Unix epoch seconds. */
export function localDateTimeToEpochSeconds(date: string, localTime: string, timeZone: string): number {
  const { year, month, day } = parseDateParts(date);
  const { hour, minute, second } = parseTimeParts(localTime);
  const zdt = Temporal.ZonedDateTime.from(
    { year, month, day, hour, minute, second, timeZone },
    { overflow: "reject" },
  );
  return Math.floor(Number(zdt.epochNanoseconds) / 1_000_000_000);
}

/** Inclusive start/end of a calendar day in the given timezone (for list_events windows). */
export function localDateDayBounds(
  date: string,
  timeZone: string,
): { start: number; end: number } {
  const { year, month, day } = parseDateParts(date);
  const dayStart = Temporal.ZonedDateTime.from(
    { year, month, day, hour: 0, minute: 0, second: 0, timeZone },
    { overflow: "reject" },
  );
  const dayEnd = dayStart.add({ days: 1 }).subtract({ seconds: 1 });
  return {
    start: Math.floor(Number(dayStart.epochNanoseconds) / 1_000_000_000),
    end: Math.floor(Number(dayEnd.epochNanoseconds) / 1_000_000_000),
  };
}

/**
 * Resolve event start/end from either Unix epochs or `{ date, startLocal, endLocal, timezone }`.
 * Epoch fields win when both are supplied.
 */
export function resolveEventWindow(input: LocalSlotInput): ResolvedEventWindow {
  const startEpoch = readNumber(input.startTime);
  const endEpoch = readNumber(input.endTime);
  if (startEpoch != null && endEpoch != null) {
    if (endEpoch <= startEpoch) {
      throw new Error("endTime must be after startTime");
    }
    const timezone = readString(input.timezone) || readString(input.timeZone) || undefined;
    return { startTime: startEpoch, endTime: endEpoch, timezone, resolvedFrom: "epoch" };
  }

  const date = readString(input.date);
  if (!date) {
    throw new Error("provide startTime/endTime or date + startLocal + endLocal + timezone");
  }
  const timeZone = readTimezone(input);
  const startLocal = readLocalTime(input, "start");
  const endLocal = readLocalTime(input, "end");
  const startTime = localDateTimeToEpochSeconds(date, startLocal, timeZone);
  const endTime = localDateTimeToEpochSeconds(date, endLocal, timeZone);
  if (endTime <= startTime) {
    throw new Error("endLocal must be after startLocal");
  }
  return { startTime, endTime, timezone: timeZone, resolvedFrom: "local_slot" };
}

/** Resolve list_events window from epochs or `{ date, timezone }`. */
export function resolveListEventsWindow(input: LocalSlotInput): {
  start: number;
  end: number;
  timezone?: string;
  resolvedFrom: "local_slot" | "epoch";
} {
  const start = readNumber(input.startTime ?? input.start);
  const end = readNumber(input.endTime ?? input.end);
  if (start != null && end != null) {
    if (end <= start) throw new Error("end must be after start");
    return {
      start,
      end,
      timezone: readString(input.timezone) || readString(input.timeZone) || undefined,
      resolvedFrom: "epoch",
    };
  }

  const date = readString(input.date);
  if (!date) {
    throw new Error("provide start/end epochs or date + timezone");
  }
  const timeZone = readTimezone(input);
  const bounds = localDateDayBounds(date, timeZone);
  return { ...bounds, timezone: timeZone, resolvedFrom: "local_slot" };
}
