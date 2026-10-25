#!/usr/bin/env npx tsx
/**
 * Unit tests: owner calendar across all calendar accounts (merge of FreeBusy and events,
 * choice of the calendar account for a write or a read, denied writes, Meet links, one event,
 * end time zone of a write).
 * Spec: openspec/changes/calendar-all-accounts/specs/owner-calendar/spec.md and
 * openspec/changes/calendar-meet-and-event-tools/specs/owner-calendar/spec.md and
 * openspec/changes/calendar-event-end-timezone/specs/owner-calendar/spec.md
 *
 * Usage: npm run test:owner-calendar
 */
import assert from "node:assert/strict";

import {
  AllCalendarAccountsFailedError,
  OWNER_DENIED_WRITE_MESSAGE,
  buildCreateEventArgs,
  buildPatchEventArgs,
  resolveEventEnd,
  chooseCalendarAccount,
  chooseWriteAccount,
  enabledAccountsDefaultFirst,
  throwWhenAllFailed,
  interpretWriteResult,
  isNotFoundError,
  mergeAccountEvents,
  mergeAccountFreeSlots,
  readEventDetail,
  wantsMeetingRoom,
} from "../src/connectors/composio/calendarOwner.js";
import { combineCalendarFreeBusy as combine } from "../src/connectors/composio/calendarAvailability.js";
import { connectorsToolBlockReason } from "../src/mcpToolPolicy.js";

const A = { connectedAccountId: "ca_A", accountKey: "acct_a", email: "owner@gmail.com", enabled: true, isDefault: true };
const B = { connectedAccountId: "ca_B", accountKey: "acct_b", email: "owner@work.com", enabled: true };
const C = { connectedAccountId: "ca_C", accountKey: "acct_c", email: "db@example.com", enabled: true };

const WINDOW = {
  timeMin: "2026-10-13T07:00:00.000Z",
  timeMax: "2026-10-14T07:00:00.000Z",
  timezone: "America/Los_Angeles",
};

function slots(calendars, items = Object.keys(calendars)) {
  return { ...WINDOW, items, calendars };
}

function freeContains(free, startIso, endIso) {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  return free.some((iv) => Date.parse(iv.start) <= s && Date.parse(iv.end) >= e);
}

// --- Owner availability covers all calendar accounts ---
{
  const merged = mergeAccountFreeSlots(
    [
      { account: A, ok: true, value: slots({ primary: { busy: [], free: [] } }, ["primary"]) },
      {
        account: B,
        ok: true,
        value: slots(
          {
            primary: {
              busy: [{ start: "2026-10-13T12:40:00-07:00", end: "2026-10-13T13:00:00-07:00" }],
              free: [],
            },
          },
          ["primary"],
        ),
      },
    ],
    WINDOW,
  );
  const combined = combineAll(merged);
  assert.ok(
    combined.busy.some((iv) => Date.parse(iv.start) === Date.parse("2026-10-13T12:40:00-07:00")),
    "busy block of calendar account B is in the combined busy time",
  );
  assert.ok(
    !freeContains(combined.free, "2026-10-13T12:30:00-07:00", "2026-10-13T13:00:00-07:00"),
    "12:30–13:00 is not free",
  );
  assert.ok(merged.calendars["owner@gmail.com"], "primary of A is renamed to its email");
  assert.ok(merged.calendars["owner@work.com"], "primary of B is renamed to its email");
  assert.equal(merged.incomplete, false);
  assert.deepEqual(
    merged.accounts.map((a) => [a.accountKey, a.ok]),
    [
      ["acct_a", true],
      ["acct_b", true],
    ],
  );
}

// One calendar account: same busy time as before.
{
  const busy = [{ start: "2026-10-13T09:00:00-07:00", end: "2026-10-13T10:00:00-07:00" }];
  const merged = mergeAccountFreeSlots(
    [{ account: A, ok: true, value: slots({ primary: { busy, free: [] } }, ["primary"]) }],
    WINDOW,
  );
  const combined = combineAll(merged);
  assert.equal(combined.busy.length, 1);
  assert.equal(Date.parse(combined.busy[0].start), Date.parse(busy[0].start));
  assert.equal(Date.parse(combined.busy[0].end), Date.parse(busy[0].end));
}

// --- The free-slots response names each calendar account; one fails ---
{
  const merged = mergeAccountFreeSlots(
    [
      {
        account: A,
        ok: true,
        value: slots({
          "owner@gmail.com": {
            busy: [{ start: "2026-10-13T09:00:00-07:00", end: "2026-10-13T10:00:00-07:00" }],
            free: [],
          },
        }),
      },
      { account: B, ok: false, error: "Composio 500" },
    ],
    WINDOW,
  );
  assert.equal(merged.incomplete, true);
  const b = merged.accounts.find((a) => a.accountKey === "acct_b");
  assert.equal(b.ok, false);
  assert.equal(b.error, "Composio 500");
  assert.equal(combineAll(merged).busy.length, 1, "busy time of calendar account A stays");
}

// --- Explicit calendar ids use the calendar account that can read them ---
{
  const notFound = [{ domain: "global", reason: "notFound" }];
  const merged = mergeAccountFreeSlots(
    [
      { account: A, ok: true, value: slots({ "work@example.com": { busy: [], free: [], errors: notFound } }) },
      {
        account: B,
        ok: true,
        value: slots({
          "work@example.com": {
            busy: [{ start: "2026-10-13T12:40:00-07:00", end: "2026-10-13T13:00:00-07:00" }],
            free: [],
          },
        }),
      },
    ],
    WINDOW,
  );
  const cal = merged.calendars["work@example.com"];
  assert.equal(cal.errors, undefined, "the error of calendar account A does not hide the busy time");
  assert.equal(cal.busy.length, 1);

  const unreadable = mergeAccountFreeSlots(
    [{ account: A, ok: true, value: slots({ "boss@example.com": { busy: [], free: [], errors: notFound } }) }],
    WINDOW,
  );
  assert.deepEqual(unreadable.calendars["boss@example.com"].errors, notFound, "unreadable calendar keeps its errors");
}

// --- Owner calendar events cover all calendar accounts; one event appears once ---
{
  const merged = mergeAccountEvents([
    {
      account: A,
      ok: true,
      value: [
        { id: "dentist", summary: "Dentist", start: "2026-10-13T15:00:00-07:00", calendarId: "owner@gmail.com", accessRole: "owner" },
        { id: "E", summary: "(No title)", start: "2026-10-13T12:30:00-07:00", calendarId: "team@example.com", accessRole: "freeBusyReader" },
      ],
    },
    {
      account: B,
      ok: true,
      value: [
        { id: "sprint", summary: "Sprint planning", start: "2026-10-13T10:30:00-07:00", calendarId: "owner@work.com", accessRole: "owner" },
        { id: "E", summary: "Sync", start: "2026-10-13T12:30:00-07:00", calendarId: "Team@Example.com", accessRole: "owner" },
      ],
    },
  ]);
  assert.deepEqual(
    merged.events.map((e) => e.summary),
    ["Sprint planning", "Sync", "Dentist"],
    "events of both calendar accounts in start-time order, shared event once",
  );
  const sync = merged.events.find((e) => e.id === "E");
  assert.equal(sync.accountKey, "acct_b");
  assert.equal(sync.connectedAccountId, "ca_B");
  assert.equal(merged.events.find((e) => e.id === "dentist").accountKey, "acct_a");
  assert.equal(merged.incomplete, false);

  const limited = mergeAccountEvents(
    [{ account: A, ok: true, value: [{ id: "1", start: "2026-10-13T08:00:00Z" }, { id: "2", start: "2026-10-13T09:00:00Z" }] }],
    1,
  );
  assert.equal(limited.events.length, 1);
}

// --- Choice of the calendar account for a write ---
const lists = new Map([
  [
    "ca_A",
    [
      { id: "owner@gmail.com", accessRole: "owner", primary: true },
      { id: "db@example.com", accessRole: "freeBusyReader" },
      { id: "team@example.com", accessRole: "writer" },
      { id: "b@example.com", accessRole: "writer" },
      { id: "boss@example.com", accessRole: "reader" },
    ],
  ],
  [
    "ca_B",
    [
      { id: "owner@work.com", accessRole: "owner", primary: true },
      { id: "work@example.com", accessRole: "owner" },
      { id: "team@example.com", accessRole: "writer" },
      { id: "b@example.com", accessRole: "owner" },
      { id: "boss@example.com", accessRole: "reader" },
    ],
  ],
  [
    "ca_C",
    [
      { id: "db@example.com", accessRole: "owner", primary: true },
      { id: "boss@example.com", accessRole: "reader" },
    ],
  ],
]);
const ACCOUNTS = [A, B, C];

{
  const work = chooseWriteAccount(ACCOUNTS, lists, { calendarId: "work@example.com" });
  assert.equal(work.ok && work.account.connectedAccountId, "ca_B", "only B can write the work calendar");

  const db = chooseWriteAccount(ACCOUNTS, lists, { calendarId: "DB@example.com" });
  assert.equal(db.ok && db.account.connectedAccountId, "ca_C", "only C can write db@example.com (case-insensitive)");

  const team = chooseWriteAccount(ACCOUNTS, lists, { calendarId: "team@example.com" });
  assert.equal(team.ok && team.account.connectedAccountId, "ca_A", "two writers: the default calendar account wins");

  const b = chooseWriteAccount(ACCOUNTS, lists, { calendarId: "b@example.com" });
  assert.equal(b.ok && b.account.connectedAccountId, "ca_B", "owner wins over writer");

  const self = chooseWriteAccount(
    [A, C],
    new Map([
      ["ca_A", [{ id: "db@example.com", accessRole: "owner" }]],
      ["ca_C", [{ id: "db@example.com", accessRole: "owner", primary: true }]],
    ]),
    { calendarId: "db@example.com" },
  );
  assert.equal(self.ok && self.account.connectedAccountId, "ca_C", "same role: the calendar account whose email is the target wins over the default");

  const boss = chooseWriteAccount(ACCOUNTS, lists, { calendarId: "boss@example.com" });
  assert.equal(boss.ok, false);
  assert.equal(boss.kind, "no_writer");
  assert.deepEqual(
    boss.writableCalendars.find((w) => w.accountKey === "acct_c").calendars,
    ["db@example.com"],
    "the refusal lists the writable calendars of each calendar account",
  );

  const primary = chooseWriteAccount(ACCOUNTS, lists, { calendarId: "primary" });
  assert.equal(primary.ok, false);
  assert.equal(primary.kind, "primary_ambiguous");

  const onePrimary = chooseWriteAccount([A], new Map(), { calendarId: "primary" });
  assert.equal(onePrimary.ok && onePrimary.account.connectedAccountId, "ca_A", "primary with one calendar account");

  const explicit = chooseWriteAccount(ACCOUNTS, new Map(), { calendarId: "primary", connectedAccountId: "ca_B" });
  assert.equal(explicit.ok && explicit.account.connectedAccountId, "ca_B", "connectedAccountId wins");

  const unknown = chooseWriteAccount(ACCOUNTS, new Map(), { calendarId: "x@example.com", connectedAccountId: "ca_Z" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.kind, "unknown_account");
}

// --- Calendar writes keep the safety rails: a denied write ---
{
  const denied = interpretWriteResult(B, "owner@work.com", "GOOGLECALENDAR_CREATE_EVENT", {
    successful: false,
    error: "Owner denied or timed out: GOOGLECALENDAR_CREATE_EVENT",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.kind, "denied");
  assert.equal(denied.message, OWNER_DENIED_WRITE_MESSAGE);
  assert.match(denied.message, /Do not retry/);

  const written = interpretWriteResult(B, "owner@work.com", "GOOGLECALENDAR_CREATE_EVENT", {
    successful: true,
    data: {
      data: {
        response_data: {
          id: "evt1",
          htmlLink: "https://www.google.com/calendar/event?eid=x",
          start: { dateTime: "2026-10-13T13:00:00-07:00" },
          end: { dateTime: "2026-10-13T13:20:00-07:00" },
        },
      },
    },
  });
  assert.equal(written.ok, true);
  assert.equal(written.accountKey, "acct_b");
  assert.deepEqual(written.event, {
    id: "evt1",
    htmlLink: "https://www.google.com/calendar/event?eid=x",
    start: "2026-10-13T13:00:00-07:00",
    end: "2026-10-13T13:20:00-07:00",
  });

  const failed = interpretWriteResult(B, "owner@work.com", "GOOGLECALENDAR_CREATE_EVENT", {
    successful: false,
    error: "Google API error: Not Found",
  });
  assert.equal(failed.kind, "error");
}

// --- A disabled calendar account is not queried; default calendar account first ---
{
  const disabledB = { ...B, enabled: false };
  const enabled = enabledAccountsDefaultFirst([C, disabledB, A]);
  assert.deepEqual(enabled.map((a) => a.connectedAccountId), ["ca_A", "ca_C"]);
}

// --- All calendar accounts fail: error (the routes answer 502) ---
{
  assert.throws(
    () => throwWhenAllFailed([
      { account: A, ok: false, error: "boom" },
      { account: B, ok: false, error: "boom" },
    ]),
    AllCalendarAccountsFailedError,
  );
  assert.doesNotThrow(() =>
    throwWhenAllFailed([
      { account: A, ok: false, error: "boom" },
      { account: B, ok: true, value: [] },
    ]),
  );
}

// The Joshu API resolves the end time zone first (resolveEventEnd), then builds the Composio arguments.
function createArgs(input) {
  const end = resolveEventEnd(input);
  assert.equal(end.ok, true, end.message);
  return buildCreateEventArgs(input.calendarId, { ...input, end: end.end });
}

// --- An owner calendar write can give the end in another time zone ---
{
  const flight = {
    calendarId: "owner@work.com",
    summary: "AA 6299 LAX to XNA",
    start: "2026-10-20T11:25:00",
    end: "2026-10-20T16:50:00",
    timezone: "America/Los_Angeles",
    endTimezone: "America/Chicago",
  };
  const created = createArgs(flight);
  assert.equal(created.start_datetime, "2026-10-20T11:25:00", "the start stays local in timezone");
  assert.equal(created.timezone, "America/Los_Angeles");
  assert.equal(created.end_datetime, "2026-10-20T16:50:00-05:00", "the end gets the offset of endTimezone");
  assert.equal(
    Date.parse(created.end_datetime) - Date.parse("2026-10-20T11:25:00-07:00"),
    (3 * 60 + 25) * 60_000,
    "the flight lasts 3 hours and 25 minutes",
  );
  assert.equal("endTimezone" in created, false, "Composio gets no unknown field");

  // No end time zone: start and end go to Composio unchanged, with timezone.
  const plain = createArgs({ ...flight, endTimezone: undefined });
  assert.equal(plain.end_datetime, "2026-10-20T16:50:00");
  assert.equal(plain.timezone, "America/Los_Angeles");

  // An end with an offset keeps its offset.
  const withOffset = createArgs({ ...flight, end: "2026-10-20T16:50:00-05:00" });
  assert.equal(withOffset.end_datetime, "2026-10-20T16:50:00-05:00");

  // The offset follows daylight saving time: Central standard time in December.
  const winter = createArgs({ ...flight, end: "2026-12-20T16:50:00" });
  assert.equal(winter.end_datetime, "2026-12-20T16:50:00-06:00");

  // Move only the end of the return flight (XNA 5:20 PM CT to LAX 7:11 PM PT).
  const patchInput = { calendarId: "owner@work.com", end: "2026-10-20T19:11:00", endTimezone: "America/Los_Angeles" };
  const patchEnd = resolveEventEnd(patchInput);
  assert.equal(patchEnd.ok, true);
  const patched = buildPatchEventArgs("owner@work.com", "evt1", { ...patchInput, end: patchEnd.end });
  assert.deepEqual(patched, {
    calendar_id: "owner@work.com",
    event_id: "evt1",
    end_time: "2026-10-20T19:11:00-07:00",
  });
  const returnFlight = createArgs({
    ...flight,
    start: "2026-10-20T17:20:00",
    timezone: "America/Chicago",
    end: "2026-10-20T19:11:00",
    endTimezone: "America/Los_Angeles",
  });
  assert.equal(
    Date.parse(returnFlight.end_datetime) - Date.parse("2026-10-20T17:20:00-05:00"),
    (3 * 60 + 51) * 60_000,
    "the return flight lasts 3 hours and 51 minutes",
  );
}

// --- The Joshu API refuses a wrong end time zone ---
{
  const base = {
    calendarId: "owner@work.com",
    summary: "Flight",
    start: "2026-10-20T11:25:00",
    end: "2026-10-20T16:50:00",
    timezone: "America/Los_Angeles",
  };
  const badZone = resolveEventEnd({ ...base, endTimezone: "Central" });
  assert.equal(badZone.ok, false);
  assert.match(badZone.message, /endTimezone/);

  const noEnd = resolveEventEnd({ endTimezone: "America/Chicago" });
  assert.equal(noEnd.ok, false);
  assert.match(noEnd.message, /endTimezone needs end/);

  const dateOnly = resolveEventEnd({ ...base, end: "2026-10-21", endTimezone: "America/Chicago" });
  assert.equal(dateOnly.ok, false, "an all-day end has no time zone");
}

// --- The companion books with the Joshu API calendar tools ---
{
  const reason = connectorsToolBlockReason("nylas_create_event", {
    enabled: true,
    connectorsBlockedTools: ["nylas_create_event"],
  });
  assert.match(reason, /google_calendar_create_event/);
}

// --- A remote meeting gets a Google Meet link by default ---
{
  const guests = ["guest@example.com"];
  assert.equal(wantsMeetingRoom({ attendees: guests }), true, "guests and no location: Meet");
  assert.equal(wantsMeetingRoom({ attendees: guests, location: "1 Main St, Palo Alto" }), false, "a place: no Meet");
  assert.equal(wantsMeetingRoom({ attendees: guests, location: "https://zoom.us/j/123" }), false, "another link: no Meet");
  assert.equal(wantsMeetingRoom({ attendees: [] }), false, "a hold without guests: no Meet");
  assert.equal(wantsMeetingRoom({}), false, "a hold without guests: no Meet");
  assert.equal(wantsMeetingRoom({ attendees: guests, createMeetingRoom: false }), false, "the caller wins");
  assert.equal(wantsMeetingRoom({ createMeetingRoom: true }), true, "the caller wins");

  const base = { calendarId: "db@example.com", summary: "Demo", start: "2026-10-15T11:00:00", end: "2026-10-15T11:30:00", timezone: "America/Los_Angeles" };
  assert.equal(buildCreateEventArgs("db@example.com", { ...base, attendees: guests }).create_meeting_room, true);
  assert.equal(buildCreateEventArgs("db@example.com", base).create_meeting_room, false);
}

// --- An update can add a Meet link and set busy or free ---
{
  const input = { calendarId: "db@example.com", transparency: "transparent", sendUpdates: "all" };
  const withMeet = buildPatchEventArgs("db@example.com", "evt1", input, "req-1");
  assert.equal(withMeet.transparency, "transparent");
  assert.equal(withMeet.send_updates, "all");
  assert.equal(withMeet.conference_data.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(withMeet.conference_data_version, 1);
  const noMeet = buildPatchEventArgs("db@example.com", "evt1", input);
  assert.ok(!("conference_data" in noMeet) && !("conference_data_version" in noMeet), "no Meet request: conference data untouched");
}

// --- One event with its guests and its meeting link ---
{
  const event = readEventDetail({
    data: {
      response_data: {
        id: "evt1",
        summary: "Keiki demo",
        status: "confirmed",
        start: { dateTime: "2026-10-15T11:00:00-07:00" },
        end: { dateTime: "2026-10-15T11:30:00-07:00" },
        organizer: { email: "db@example.com" },
        attendees: [
          { email: "db@example.com", organizer: true, self: true, responseStatus: "accepted" },
          { email: "axel@example.com", displayName: "Axel", responseStatus: "needsAction" },
          { displayName: "no email" },
        ],
        conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
      },
    },
  });
  assert.equal(event.id, "evt1");
  assert.equal(event.start, "2026-10-15T11:00:00-07:00");
  assert.equal(event.organizer, "db@example.com");
  assert.equal(event.meetLink, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(event.attendees.map((a) => [a.email, a.responseStatus]), [
    ["db@example.com", "accepted"],
    ["axel@example.com", "needsAction"],
  ]);
  assert.equal(readEventDetail({ hangoutLink: "https://meet.google.com/x" }).meetLink, "https://meet.google.com/x");
  assert.equal(readEventDetail({ id: "e" }).meetLink, undefined);

  const created = interpretWriteResult(A, "db@example.com", "GOOGLECALENDAR_CREATE_EVENT", {
    successful: true,
    data: { response_data: { id: "evt2", hangoutLink: "https://meet.google.com/y", attendees: [] } },
  });
  assert.equal(created.ok && created.event.meetLink, "https://meet.google.com/y", "the write result names the Meet link");
}

// --- The event is not on the calendar: status 404 ---
{
  assert.equal(isNotFoundError("HTTP 404: Not Found"), true);
  assert.equal(isNotFoundError("Resource has been deleted (410)"), true);
  assert.equal(isNotFoundError("event not found"), true);
  assert.equal(isNotFoundError("Rate limit exceeded"), false);
  assert.equal(isNotFoundError(undefined), false);
}

// --- Read of one event: the calendar account that can read the calendar ---
{
  const boss = chooseCalendarAccount(ACCOUNTS, lists, { calendarId: "boss@example.com" }, "read");
  assert.equal(boss.ok && boss.account.connectedAccountId, "ca_A", "three readers: the default calendar account wins");
  const db = chooseCalendarAccount(ACCOUNTS, lists, { calendarId: "db@example.com" }, "read");
  assert.equal(db.ok && db.account.connectedAccountId, "ca_C", "freeBusyReader cannot read the event; owner C can");
  const none = chooseCalendarAccount(ACCOUNTS, lists, { calendarId: "other@example.com" }, "read");
  assert.equal(none.ok, false);
  assert.equal(none.kind, "no_reader");
  assert.ok(none.writableCalendars.find((w) => w.accountKey === "acct_c").calendars.includes("boss@example.com"));
}

function combineAll(merged) {
  // Same union as the free-slots route: calendars.combined over all merged calendars.
  return combine(merged.calendars, merged.timeMin, merged.timeMax);
}

console.log("test-owner-calendar: ok");
