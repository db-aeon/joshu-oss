/**
 * Owner calendar across all calendar accounts: owner availability, owner calendar events,
 * one event with its guests, and writes with the calendar account that can write the target calendar.
 * Spec: openspec/changes/calendar-all-accounts/specs/owner-calendar/spec.md and
 * openspec/changes/calendar-meet-and-event-tools/specs/owner-calendar/spec.md
 */
import { Temporal } from "@js-temporal/polyfill";
import { randomUUID } from "node:crypto";

import { isOwnerChannelDeniedMessage } from "../../composio/modifiers/ownerChannelBeforeExecute.js";
import { isValidIanaTimezone, normalizeIanaTimezone } from "../../ianaTimezone.js";
import { listCalendarRegistryAccounts, type CalendarRegistryAccount } from "./calendarAccounts.js";
import {
  executeCalendar,
  fetchGoogleCalendarEventsForAccount,
  fetchGoogleCalendarFreeSlots,
  fetchGoogleCalendarList,
  type GoogleCalendarEntry,
  type GoogleCalendarEventSummary,
  type GoogleCalendarFreeSlotsResult,
} from "./calendar.js";
import { combineCalendarFreeBusy } from "./calendarAvailability.js";

export type CalendarAccountStatus = {
  connectedAccountId: string;
  accountKey: string;
  email?: string;
  ok: boolean;
  error?: string;
};

/** The result of one Composio call for one calendar account. */
export type AccountResult<T> =
  | { account: CalendarRegistryAccount; ok: true; value: T }
  | { account: CalendarRegistryAccount; ok: false; error: string };

export type OwnerFreeSlotsResult = GoogleCalendarFreeSlotsResult & {
  accounts: CalendarAccountStatus[];
  incomplete: boolean;
};

export type OwnerCalendarEvent = GoogleCalendarEventSummary & {
  connectedAccountId: string;
  accountKey: string;
};

export type OwnerCalendarEventsResult = {
  events: OwnerCalendarEvent[];
  accounts: CalendarAccountStatus[];
  incomplete: boolean;
};

/** Thrown when the Composio calls fail for all calendar accounts. */
export class AllCalendarAccountsFailedError extends Error {
  readonly accounts: CalendarAccountStatus[];
  constructor(accounts: CalendarAccountStatus[]) {
    super(
      `All calendar accounts failed: ${accounts.map((a) => `${a.email ?? a.accountKey}: ${a.error ?? "error"}`).join("; ")}`,
    );
    this.name = "AllCalendarAccountsFailedError";
    this.accounts = accounts;
  }
}

/** Keep the enabled calendar accounts, default calendar account first. */
export function enabledAccountsDefaultFirst(accounts: CalendarRegistryAccount[]): CalendarRegistryAccount[] {
  return accounts
    .filter((a) => a.enabled !== false)
    .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
}

/** Enabled calendar accounts, default calendar account first. */
export async function listEnabledCalendarAccounts(projectRoot: string): Promise<CalendarRegistryAccount[]> {
  return enabledAccountsDefaultFirst(await listCalendarRegistryAccounts(projectRoot));
}

async function runPerAccount<T>(
  accounts: CalendarRegistryAccount[],
  fn: (account: CalendarRegistryAccount) => Promise<T>,
): Promise<AccountResult<T>[]> {
  const settled = await Promise.allSettled(accounts.map((account) => fn(account)));
  return settled.map((row, i) =>
    row.status === "fulfilled"
      ? { account: accounts[i]!, ok: true as const, value: row.value }
      : {
          account: accounts[i]!,
          ok: false as const,
          error: row.reason instanceof Error ? row.reason.message : String(row.reason),
        },
  );
}

function accountStatuses<T>(results: AccountResult<T>[]): CalendarAccountStatus[] {
  return results.map((r) => ({
    connectedAccountId: r.account.connectedAccountId,
    accountKey: r.account.accountKey,
    ...(r.account.email ? { email: r.account.email } : {}),
    ok: r.ok,
    ...(r.ok ? {} : { error: r.error }),
  }));
}

/** Throw AllCalendarAccountsFailedError when the calls failed for all calendar accounts. */
export function throwWhenAllFailed<T>(results: AccountResult<T>[]): void {
  if (results.length > 0 && results.every((r) => !r.ok)) {
    throw new AllCalendarAccountsFailedError(accountStatuses(results));
  }
}

function calendarKey(calendarId: string, account: CalendarRegistryAccount): string {
  // "primary" names a different calendar for each calendar account.
  if (calendarId === "primary" && account.email) return account.email.toLowerCase();
  return calendarId.includes("@") ? calendarId.toLowerCase() : calendarId;
}

/**
 * Merge per-account FreeBusy results. For each calendar id, use the busy time of each
 * calendar account that read the calendar without an error.
 */
export function mergeAccountFreeSlots(
  results: AccountResult<GoogleCalendarFreeSlotsResult>[],
  window: { timeMin: string; timeMax: string; timezone: string },
): OwnerFreeSlotsResult {
  const okResults = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  const timeMin = okResults.find((r) => r.value.timeMin)?.value.timeMin || window.timeMin;
  const timeMax = okResults.find((r) => r.value.timeMax)?.value.timeMax || window.timeMax;

  const busyByKey = new Map<string, GoogleCalendarFreeSlotsResult["calendars"][string]["busy"]>();
  const errorsByKey = new Map<string, unknown[]>();
  const items: string[] = [];

  for (const r of okResults) {
    for (const item of r.value.items ?? []) {
      const key = calendarKey(item, r.account);
      if (!items.includes(key)) items.push(key);
    }
    for (const [calendarId, cal] of Object.entries(r.value.calendars)) {
      const key = calendarKey(calendarId, r.account);
      if (cal.errors && cal.errors.length > 0) {
        if (!errorsByKey.has(key)) errorsByKey.set(key, cal.errors);
        continue;
      }
      busyByKey.set(key, [...(busyByKey.get(key) ?? []), ...cal.busy]);
    }
  }

  const calendars: GoogleCalendarFreeSlotsResult["calendars"] = {};
  for (const [key, busy] of busyByKey) {
    calendars[key] = combineCalendarFreeBusy({ [key]: { busy, free: [] } }, timeMin, timeMax);
  }
  for (const [key, errors] of errorsByKey) {
    if (!calendars[key]) calendars[key] = { busy: [], free: [], errors };
  }

  return {
    timeMin,
    timeMax,
    timezone: window.timezone,
    items,
    calendars,
    accounts: accountStatuses(results),
    incomplete: results.some((r) => !r.ok),
  };
}

/** Owner availability: Google FreeBusy of all enabled calendar accounts. */
export async function fetchOwnerFreeSlots(
  projectRoot: string,
  opts: { items?: string[]; timeMin: string; timeMax: string; timezone: string },
): Promise<OwnerFreeSlotsResult> {
  const accounts = await listEnabledCalendarAccounts(projectRoot);
  if (accounts.length === 0) throw new Error("No Google Calendar account");
  const results = await runPerAccount(accounts, (account) =>
    fetchGoogleCalendarFreeSlots(projectRoot, { connectedAccountId: account.connectedAccountId }, opts),
  );
  throwWhenAllFailed(results);
  return mergeAccountFreeSlots(results, opts);
}

const ACCESS_ROLE_RANK: Record<string, number> = {
  owner: 4,
  writer: 3,
  reader: 2,
  freeBusyReader: 1,
};

function accessRoleRank(role: string | undefined): number {
  return role ? (ACCESS_ROLE_RANK[role] ?? 0) : 0;
}

function startMs(ev: GoogleCalendarEventSummary): number {
  const ms = ev.start ? Date.parse(ev.start) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Merge per-account event lists. One event (same calendar id and event id) appears once:
 * the copy from the calendar account with the highest access role on that calendar.
 */
export function mergeAccountEvents(
  results: AccountResult<GoogleCalendarEventSummary[]>[],
  limit?: number,
): OwnerCalendarEventsResult {
  const byKey = new Map<string, OwnerCalendarEvent>();
  for (const r of results) {
    if (!r.ok) continue;
    for (const ev of r.value) {
      const key = `${(ev.calendarId ?? "").toLowerCase()}\n${ev.id}`;
      const prev = byKey.get(key);
      if (prev && accessRoleRank(prev.accessRole) >= accessRoleRank(ev.accessRole)) continue;
      byKey.set(key, {
        ...ev,
        connectedAccountId: r.account.connectedAccountId,
        accountKey: r.account.accountKey,
      });
    }
  }
  const events = [...byKey.values()].sort((a, b) => startMs(a) - startMs(b));
  return {
    events: limit != null && limit >= 0 ? events.slice(0, limit) : events,
    accounts: accountStatuses(results),
    incomplete: results.some((r) => !r.ok),
  };
}

/** Owner calendar events of all enabled calendar accounts, merged and sorted by start time. */
export async function fetchOwnerCalendarEvents(
  projectRoot: string,
  opts: Parameters<typeof fetchGoogleCalendarEventsForAccount>[2] = {},
  /** Cap on the merged event list (earliest events first). Omit for all events in the window. */
  limit?: number,
): Promise<OwnerCalendarEventsResult> {
  const accounts = await listEnabledCalendarAccounts(projectRoot);
  if (accounts.length === 0) throw new Error("No Google Calendar account");
  const results = await runPerAccount(accounts, (account) =>
    fetchGoogleCalendarEventsForAccount(projectRoot, { connectedAccountId: account.connectedAccountId }, opts),
  );
  throwWhenAllFailed(results);
  return mergeAccountEvents(results, limit);
}

// --- Choice of the calendar account for one calendar ---

/** What the caller does on the target calendar: write an event, or read one event. */
export type CalendarAccess = "write" | "read";

/** For each calendar account, the calendars it can write (or read). */
export type WritableCalendars = { accountKey: string; email?: string; calendars: string[] }[];

export type CalendarAccountChoice =
  | { ok: true; account: CalendarRegistryAccount }
  | {
      ok: false;
      kind: "unknown_account" | "primary_ambiguous" | "no_writer" | "no_reader";
      message: string;
      writableCalendars?: WritableCalendars;
    };
export type WriteAccountChoice = CalendarAccountChoice;

const ROLE_RANK_BY_ACCESS: Record<CalendarAccess, Record<string, number>> = {
  write: { owner: 2, writer: 1 },
  // freeBusyReader sees busy time only, not the event.
  read: { owner: 3, writer: 2, reader: 1 },
};

/** Lexicographic compare of two score lists of the same length. */
function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function accessibleCalendars(
  accounts: CalendarRegistryAccount[],
  calendarLists: Map<string, GoogleCalendarEntry[]>,
  access: CalendarAccess,
): WritableCalendars {
  const rank = ROLE_RANK_BY_ACCESS[access];
  return accounts.map((account) => ({
    accountKey: account.accountKey,
    ...(account.email ? { email: account.email } : {}),
    calendars: (calendarLists.get(account.connectedAccountId) ?? [])
      .filter((cal) => rank[cal.accessRole ?? ""])
      .map((cal) => cal.id),
  }));
}

/**
 * Choose the calendar account that can write (or read) the target calendar.
 * `accounts` are the enabled calendar accounts, default calendar account first.
 */
export function chooseCalendarAccount(
  accounts: CalendarRegistryAccount[],
  calendarLists: Map<string, GoogleCalendarEntry[]>,
  target: { calendarId: string; connectedAccountId?: string },
  access: CalendarAccess,
): CalendarAccountChoice {
  if (target.connectedAccountId) {
    const account = accounts.find((a) => a.connectedAccountId === target.connectedAccountId);
    return account
      ? { ok: true, account }
      : {
          ok: false,
          kind: "unknown_account",
          message: `connectedAccountId ${target.connectedAccountId} is not an enabled calendar account.`,
        };
  }

  const calendarId = target.calendarId.trim().toLowerCase();
  if (calendarId === "primary") {
    if (accounts.length === 1) return { ok: true, account: accounts[0]! };
    return {
      ok: false,
      kind: "primary_ambiguous",
      message:
        "calendarId primary is ambiguous: the owner has more than one calendar account. Give the calendar id (for example the owner's email) or connectedAccountId.",
    };
  }

  const rank = ROLE_RANK_BY_ACCESS[access];
  let best: { account: CalendarRegistryAccount; score: number[] } | null = null;
  accounts.forEach((account, index) => {
    const cal = (calendarLists.get(account.connectedAccountId) ?? []).find(
      (c) => c.id.toLowerCase() === calendarId,
    );
    const role = rank[cal?.accessRole ?? ""];
    if (!role) return;
    const score = [
      role,
      account.email?.toLowerCase() === calendarId ? 1 : 0,
      account.isDefault ? 1 : 0,
      -index,
    ];
    if (!best || compareScores(score, best.score) > 0) best = { account, score };
  });
  if (best) return { ok: true, account: (best as { account: CalendarRegistryAccount }).account };

  return {
    ok: false,
    kind: access === "write" ? "no_writer" : "no_reader",
    message: `No calendar account can ${access} calendar ${target.calendarId}. Use one of the ${access === "write" ? "writable" : "readable"} calendars.`,
    writableCalendars: accessibleCalendars(accounts, calendarLists, access),
  };
}

/** Choose the calendar account for a write to the target calendar. */
export function chooseWriteAccount(
  accounts: CalendarRegistryAccount[],
  calendarLists: Map<string, GoogleCalendarEntry[]>,
  target: { calendarId: string; connectedAccountId?: string },
): WriteAccountChoice {
  return chooseCalendarAccount(accounts, calendarLists, target, "write");
}

async function resolveCalendarAccount(
  projectRoot: string,
  target: { calendarId: string; connectedAccountId?: string },
  access: CalendarAccess,
): Promise<CalendarAccountChoice> {
  const accounts = await listEnabledCalendarAccounts(projectRoot);
  if (accounts.length === 0) {
    return {
      ok: false,
      kind: access === "write" ? "no_writer" : "no_reader",
      message: "No Google Calendar account is connected.",
      writableCalendars: [],
    };
  }
  const calendarLists = new Map<string, GoogleCalendarEntry[]>();
  const needsLists = !target.connectedAccountId && target.calendarId.trim().toLowerCase() !== "primary";
  if (needsLists) {
    const lists = await runPerAccount(accounts, (account) =>
      fetchGoogleCalendarList(projectRoot, { connectedAccountId: account.connectedAccountId }),
    );
    for (const r of lists) calendarLists.set(r.account.connectedAccountId, r.ok ? r.value : []);
  }
  return chooseCalendarAccount(accounts, calendarLists, target, access);
}

// --- One event with its guests ---

export type OwnerCalendarEventAttendee = {
  email: string;
  displayName?: string;
  /** Google responseStatus: needsAction, declined, tentative, or accepted. */
  responseStatus?: string;
  organizer?: boolean;
  optional?: boolean;
  self?: boolean;
};

export type OwnerCalendarEventDetail = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  status?: string;
  transparency?: "opaque" | "transparent";
  htmlLink?: string;
  /** Google Meet (or other video) link of the event, from hangoutLink or conferenceData. */
  meetLink?: string;
  organizer?: string;
  attendees?: OwnerCalendarEventAttendee[];
  recurringEventId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readEventTime(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const v = asRecord(value);
  return readString(v?.dateTime) ?? readString(v?.date);
}

function readMeetLink(row: Record<string, unknown>): string | undefined {
  const hangoutLink = readString(row.hangoutLink);
  if (hangoutLink) return hangoutLink;
  const entryPoints = asRecord(row.conferenceData)?.entryPoints;
  if (!Array.isArray(entryPoints)) return undefined;
  for (const entry of entryPoints) {
    const e = asRecord(entry);
    if (e?.entryPointType === "video" && readString(e.uri)) return e.uri as string;
  }
  return undefined;
}

/** Read the Google event in a Composio response. Composio wraps it as { data: { response_data: event } }; layers can be missing. */
export function readEventDetail(data: unknown): OwnerCalendarEventDetail {
  let row = asRecord(data) ?? {};
  for (const key of ["data", "response_data"]) row = asRecord(row[key]) ?? row;
  const attendees = Array.isArray(row.attendees)
    ? row.attendees.flatMap((raw): OwnerCalendarEventAttendee[] => {
        const a = asRecord(raw);
        const email = readString(a?.email);
        if (!a || !email) return [];
        return [
          {
            email,
            ...(readString(a.displayName) ? { displayName: a.displayName as string } : {}),
            ...(readString(a.responseStatus) ? { responseStatus: a.responseStatus as string } : {}),
            ...(a.organizer === true ? { organizer: true } : {}),
            ...(a.optional === true ? { optional: true } : {}),
            ...(a.self === true ? { self: true } : {}),
          },
        ];
      })
    : undefined;
  const transparency = row.transparency === "transparent" || row.transparency === "opaque" ? row.transparency : undefined;
  const fields: OwnerCalendarEventDetail = {
    id: readString(row.id),
    summary: readString(row.summary),
    description: readString(row.description),
    location: readString(row.location),
    start: readEventTime(row.start),
    end: readEventTime(row.end),
    status: readString(row.status),
    transparency,
    htmlLink: readString(row.htmlLink),
    meetLink: readMeetLink(row),
    organizer: readString(asRecord(row.organizer)?.email),
    attendees,
    recurringEventId: readString(row.recurringEventId),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as OwnerCalendarEventDetail;
}

export type OwnerCalendarEventReadResult =
  | {
      ok: true;
      connectedAccountId: string;
      accountKey: string;
      email?: string;
      calendarId: string;
      event: OwnerCalendarEventDetail;
    }
  | {
      ok: false;
      kind: "invalid" | "unknown_account" | "primary_ambiguous" | "no_reader" | "not_found" | "error";
      message: string;
      writableCalendars?: WritableCalendars;
    };

/** Whether a Composio error means that Google did not find the event on that calendar. */
export function isNotFoundError(message: string | undefined): boolean {
  return /\b(404|410)\b|not ?found/i.test(message ?? "");
}

/** GOOGLECALENDAR_EVENTS_GET arguments for one event. */
export function buildEventsGetArgs(calendarId: string, eventId: string, timezone?: string): Record<string, unknown> {
  return { event_id: eventId, calendar_id: calendarId, ...(timezone ? { time_zone: timezone } : {}) };
}

async function fetchEventWithAccount(
  projectRoot: string,
  account: CalendarRegistryAccount,
  calendarId: string,
  eventId: string,
  timezone?: string,
): Promise<OwnerCalendarEventReadResult> {
  const result = await executeCalendar(
    projectRoot,
    "GOOGLECALENDAR_EVENTS_GET",
    buildEventsGetArgs(calendarId, eventId, timezone),
    { connectedAccountId: account.connectedAccountId },
  );
  if (!result.successful) {
    return isNotFoundError(result.error)
      ? {
          ok: false,
          kind: "not_found",
          message: `Event ${eventId} is not on calendar ${calendarId} (${result.error ?? "not found"}). Take calendarId and eventId from google_calendar_list_events.`,
        }
      : { ok: false, kind: "error", message: result.error || "GOOGLECALENDAR_EVENTS_GET failed" };
  }
  return {
    ok: true,
    connectedAccountId: account.connectedAccountId,
    accountKey: account.accountKey,
    ...(account.email ? { email: account.email } : {}),
    calendarId,
    event: readEventDetail(result.data),
  };
}

/** Read one owner calendar event, with its guests, with the calendar account that can read the target calendar. */
export async function getOwnerCalendarEvent(
  projectRoot: string,
  eventId: string,
  target: { calendarId: string; connectedAccountId?: string; timezone?: string },
): Promise<OwnerCalendarEventReadResult> {
  const missing = [...(eventId.trim() ? [] : ["eventId"]), ...(target.calendarId?.trim() ? [] : ["calendarId"])];
  if (missing.length > 0) {
    return { ok: false, kind: "invalid", message: `Missing field(s): ${missing.join(", ")}` };
  }
  const choice = await resolveCalendarAccount(projectRoot, target, "read");
  if (!choice.ok) return choice as Extract<OwnerCalendarEventReadResult, { ok: false }>;
  return fetchEventWithAccount(projectRoot, choice.account, target.calendarId.trim(), eventId.trim(), target.timezone);
}

// --- Writes ---

export type OwnerCalendarEventInput = {
  calendarId: string;
  summary?: string;
  /** Local time YYYY-MM-DDTHH:MM:SS in `timezone`, or RFC3339 with an offset. */
  start?: string;
  /** Local time YYYY-MM-DDTHH:MM:SS in `endTimezone` (else `timezone`), or RFC3339 with an offset. */
  end?: string;
  timezone?: string;
  /** IANA time zone of `end` when it differs from `timezone`, for example the arrival airport of a flight. */
  endTimezone?: string;
  attendees?: string[];
  description?: string;
  location?: string;
  /** Google sendUpdates: all, externalOnly, or none. */
  sendUpdates?: string;
  createMeetingRoom?: boolean;
  transparency?: "opaque" | "transparent";
  connectedAccountId?: string;
};

export type OwnerCalendarWriteResult =
  | {
      ok: true;
      connectedAccountId: string;
      accountKey: string;
      email?: string;
      calendarId: string;
      event: Pick<OwnerCalendarEventDetail, "id" | "htmlLink" | "start" | "end" | "meetLink">;
    }
  | {
      ok: false;
      kind: "invalid" | "unknown_account" | "primary_ambiguous" | "no_writer" | "denied" | "error";
      message: string;
      writableCalendars?: WritableCalendars;
    };

export const OWNER_DENIED_WRITE_MESSAGE =
  "The owner denied this calendar write, or the approval timed out. No event was written. Do not retry; tell the owner if needed.";

async function writeOwnerCalendarEvent(
  projectRoot: string,
  input: OwnerCalendarEventInput,
  toolSlug: string,
  buildArgs: (
    calendarId: string,
    account: CalendarRegistryAccount,
  ) => Promise<Record<string, unknown> | { error: string }>,
): Promise<OwnerCalendarWriteResult> {
  const choice = await resolveCalendarAccount(projectRoot, input, "write");
  if (!choice.ok) return choice as Extract<OwnerCalendarWriteResult, { ok: false }>;
  const calendarId = input.calendarId.trim();
  const args = await buildArgs(calendarId, choice.account);
  if (typeof args.error === "string") return { ok: false, kind: "error", message: args.error };
  const result = await executeCalendar(projectRoot, toolSlug, args, {
    connectedAccountId: choice.account.connectedAccountId,
  });
  return interpretWriteResult(choice.account, calendarId, toolSlug, result);
}

/** Map the result of one Composio calendar write to the write result of the Joshu API. */
export function interpretWriteResult(
  account: CalendarRegistryAccount,
  calendarId: string,
  toolSlug: string,
  result: { successful: boolean; data?: unknown; error?: string },
): OwnerCalendarWriteResult {
  if (!result.successful) {
    if (isOwnerChannelDeniedMessage(result.error)) {
      return { ok: false, kind: "denied", message: OWNER_DENIED_WRITE_MESSAGE };
    }
    return { ok: false, kind: "error", message: result.error || `${toolSlug} failed` };
  }
  const { id, htmlLink, start, end, meetLink } = readEventDetail(result.data);
  const event = Object.fromEntries(
    Object.entries({ id, htmlLink, start, end, meetLink }).filter(([, v]) => v !== undefined),
  );
  return {
    ok: true,
    connectedAccountId: account.connectedAccountId,
    accountKey: account.accountKey,
    ...(account.email ? { email: account.email } : {}),
    calendarId,
    event,
  };
}

function optionalArgs(input: OwnerCalendarEventInput): Record<string, unknown> {
  return {
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.attendees?.length ? { attendees: input.attendees } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.sendUpdates ? { send_updates: input.sendUpdates } : {}),
    ...(input.transparency ? { transparency: input.transparency } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
}

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/**
 * The end time to send to Composio. Composio has one `timezone` for both ends, but it keeps
 * an explicit offset, so a local `end` in `endTimezone` becomes RFC3339 with the offset of
 * `endTimezone` on that date. Without `endTimezone`, or when `end` has an offset, `end` is unchanged.
 */
export function resolveEventEnd(
  input: Pick<OwnerCalendarEventInput, "end" | "endTimezone">,
): { ok: true; end?: string } | { ok: false; message: string } {
  const end = input.end?.trim();
  const endTimezone = input.endTimezone?.trim();
  if (!endTimezone) return { ok: true, ...(end ? { end } : {}) };
  const zone = normalizeIanaTimezone(endTimezone);
  if (!isValidIanaTimezone(zone)) {
    return { ok: false, message: `endTimezone "${endTimezone}" is not an IANA time zone, e.g. America/Chicago` };
  }
  if (!end) return { ok: false, message: "endTimezone needs end" };
  if (HAS_OFFSET.test(end)) return { ok: true, end };
  const notLocal = { ok: false as const, message: `end "${end}" is not a local time YYYY-MM-DDTHH:MM:SS` };
  if (!LOCAL_DATE_TIME.test(end)) return notLocal;
  try {
    const zoned = Temporal.PlainDateTime.from(end.replace(" ", "T")).toZonedDateTime(zone);
    return { ok: true, end: zoned.toString({ timeZoneName: "never", smallestUnit: "second" }) };
  } catch {
    return notLocal;
  }
}

/**
 * Whether a new event gets a Google Meet link. The caller's createMeetingRoom wins. Without it,
 * an event with guests and no location gets Meet: a place or another meeting link goes in location,
 * and an event without guests (a hold or a focus block) needs no video link.
 */
export function wantsMeetingRoom(input: Pick<OwnerCalendarEventInput, "createMeetingRoom" | "attendees" | "location">): boolean {
  if (typeof input.createMeetingRoom === "boolean") return input.createMeetingRoom;
  return (input.attendees?.length ?? 0) > 0 && !input.location?.trim();
}

/** Create an owner calendar event with the calendar account that can write the target calendar. */
export async function createOwnerCalendarEvent(
  projectRoot: string,
  input: OwnerCalendarEventInput,
): Promise<OwnerCalendarWriteResult> {
  const missing = (["calendarId", "summary", "start", "end", "timezone"] as const).filter(
    (field) => !input[field]?.trim(),
  );
  if (missing.length > 0) {
    return { ok: false, kind: "invalid", message: `Missing field(s): ${missing.join(", ")}` };
  }
  // Check the end time zone before the calendar account choice, so a wrong input makes no Composio call.
  const end = resolveEventEnd(input);
  if (!end.ok) return { ok: false, kind: "invalid", message: end.message };
  const resolved = { ...input, end: end.end };
  return writeOwnerCalendarEvent(projectRoot, input, "GOOGLECALENDAR_CREATE_EVENT", async (calendarId) =>
    buildCreateEventArgs(calendarId, resolved),
  );
}

/** GOOGLECALENDAR_CREATE_EVENT arguments for an owner calendar event. */
export function buildCreateEventArgs(calendarId: string, input: OwnerCalendarEventInput): Record<string, unknown> {
  return {
    calendar_id: calendarId,
    start_datetime: input.start,
    end_datetime: input.end,
    create_meeting_room: wantsMeetingRoom(input),
    ...optionalArgs(input),
  };
}

/**
 * GOOGLECALENDAR_PATCH_EVENT arguments. With meetRequestId, the patch adds a Google Meet link:
 * Google makes the link when conferenceData has a createRequest and conferenceDataVersion is 1.
 */
export function buildPatchEventArgs(
  calendarId: string,
  eventId: string,
  input: OwnerCalendarEventInput,
  meetRequestId?: string,
): Record<string, unknown> {
  return {
    calendar_id: calendarId,
    event_id: eventId,
    ...(input.start ? { start_time: input.start } : {}),
    ...(input.end ? { end_time: input.end } : {}),
    ...optionalArgs(input),
    ...(meetRequestId
      ? {
          conference_data: {
            createRequest: { requestId: meetRequestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
          },
          conference_data_version: 1,
        }
      : {}),
  };
}

/**
 * Update (patch) an owner calendar event. Only the given fields change. createMeetingRoom true
 * adds a Google Meet link when the event has no meeting link yet; an existing link stays.
 */
export async function updateOwnerCalendarEvent(
  projectRoot: string,
  eventId: string,
  input: OwnerCalendarEventInput,
): Promise<OwnerCalendarWriteResult> {
  const missing = [
    ...(eventId.trim() ? [] : ["eventId"]),
    ...(input.calendarId?.trim() ? [] : ["calendarId"]),
  ];
  if (missing.length > 0) {
    return { ok: false, kind: "invalid", message: `Missing field(s): ${missing.join(", ")}` };
  }
  const end = resolveEventEnd(input);
  if (!end.ok) return { ok: false, kind: "invalid", message: end.message };
  const resolved = { ...input, end: end.end };
  const id = eventId.trim();
  return writeOwnerCalendarEvent(projectRoot, input, "GOOGLECALENDAR_PATCH_EVENT", async (calendarId, account) => {
    let meetRequestId: string | undefined;
    if (input.createMeetingRoom === true) {
      // A second createRequest could replace the link that the guests already have.
      const current = await fetchEventWithAccount(projectRoot, account, calendarId, id);
      if (!current.ok) return { error: `Cannot read event ${id} before adding Meet: ${current.message}` };
      if (!current.event.meetLink) meetRequestId = randomUUID();
    }
    return buildPatchEventArgs(calendarId, id, resolved, meetRequestId);
  });
}
