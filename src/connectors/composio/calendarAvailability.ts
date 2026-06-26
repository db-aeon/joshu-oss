/**
 * Owner calendar FreeBusy scope — primary plus personal / selected Gmail calendars.
 */
import { readAgentProfile } from "../../nylas/profile.js";
import type { CalendarExecuteContext } from "./calendar.js";
import { fetchGoogleCalendarList, type GoogleCalendarFreeBusyInterval } from "./calendar.js";

function normalizeCalendarId(id: string): string {
  return id.trim().toLowerCase();
}

/** Gmail-style calendar ids we should include in scheduling FreeBusy (not holidays/contacts). */
export function isSchedulableEmailCalendarId(id: string): boolean {
  const lower = normalizeCalendarId(id);
  if (!lower.includes("@")) return false;
  if (lower.includes("#holiday@") || lower.includes("group.v.calendar")) return false;
  if (lower.startsWith("addressbook#")) return false;
  return true;
}

function addCalendarId(items: string[], id: string): void {
  const trimmed = id.trim();
  if (!trimmed) return;
  const normalized = normalizeCalendarId(trimmed);
  if (items.some((item) => normalizeCalendarId(item) === normalized)) return;
  items.push(trimmed);
}

/**
 * Default FreeBusy calendars: primary, profile personalEmail, and selected/reader
 * Gmail calendars on the connected Google account (e.g. dbenyamin@gmail.com).
 */
export async function resolveOwnerCalendarFreeBusyItems(
  projectRoot: string,
  ctx: CalendarExecuteContext,
  explicitItems?: string[],
): Promise<string[]> {
  if (explicitItems?.length) return explicitItems;

  const items: string[] = ["primary"];
  const profile = readAgentProfile(projectRoot);
  if (profile?.personalEmail) addCalendarId(items, profile.personalEmail);

  try {
    const calendars = await fetchGoogleCalendarList(projectRoot, ctx);
    for (const cal of calendars) {
      if (!cal.id || cal.primary) continue;
      if (!isSchedulableEmailCalendarId(cal.id)) continue;
      if (cal.selected || cal.accessRole === "owner" || cal.accessRole === "reader") {
        addCalendarId(items, cal.id);
      }
    }
  } catch {
    // Profile-based defaults only when calendar list fails.
  }

  return items;
}

function mergeOverlappingIntervals(
  intervals: GoogleCalendarFreeBusyInterval[],
): GoogleCalendarFreeBusyInterval[] {
  const sorted = intervals
    .map((interval) => ({
      startMs: Date.parse(interval.start),
      endMs: Date.parse(interval.end),
      start: interval.start,
      end: interval.end,
    }))
    .filter((row) => Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.endMs > row.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (sorted.length === 0) return [];

  const merged: GoogleCalendarFreeBusyInterval[] = [];
  let current = sorted[0]!;

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.startMs <= current.endMs) {
      if (next.endMs > current.endMs) {
        current = { ...current, endMs: next.endMs, end: next.end };
      }
    } else {
      merged.push({ start: current.start, end: current.end });
      current = next;
    }
  }
  merged.push({ start: current.start, end: current.end });
  return merged;
}

function invertBusyToFree(
  busy: GoogleCalendarFreeBusyInterval[],
  timeMin: string,
  timeMax: string,
): GoogleCalendarFreeBusyInterval[] {
  const windowStart = Date.parse(timeMin);
  const windowEnd = Date.parse(timeMax);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    return [];
  }

  const free: GoogleCalendarFreeBusyInterval[] = [];
  let cursor = windowStart;

  for (const block of busy) {
    const blockStart = Date.parse(block.start);
    const blockEnd = Date.parse(block.end);
    if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd)) continue;

    const clampedStart = Math.max(blockStart, windowStart);
    const clampedEnd = Math.min(blockEnd, windowEnd);
    if (clampedStart > cursor) {
      free.push({
        start: new Date(cursor).toISOString(),
        end: new Date(clampedStart).toISOString(),
      });
    }
    cursor = Math.max(cursor, clampedEnd);
  }

  if (cursor < windowEnd) {
    free.push({
      start: new Date(cursor).toISOString(),
      end: new Date(windowEnd).toISOString(),
    });
  }

  return free;
}

/** Union busy across calendars; free = query window minus merged busy. */
export function combineCalendarFreeBusy(
  calendars: Record<string, { busy: GoogleCalendarFreeBusyInterval[]; free: GoogleCalendarFreeBusyInterval[] }>,
  timeMin: string,
  timeMax: string,
): { busy: GoogleCalendarFreeBusyInterval[]; free: GoogleCalendarFreeBusyInterval[] } {
  const allBusy = Object.values(calendars).flatMap((cal) => cal.busy);
  const busy = mergeOverlappingIntervals(allBusy);
  const free = invertBusyToFree(busy, timeMin, timeMax);
  return { busy, free };
}
