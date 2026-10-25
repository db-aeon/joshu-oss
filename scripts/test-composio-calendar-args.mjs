#!/usr/bin/env npx tsx
/**
 * Unit test: the arguments that Joshu sends to Composio GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS,
 * GOOGLECALENDAR_CREATE_EVENT, GOOGLECALENDAR_PATCH_EVENT, and GOOGLECALENDAR_EVENTS_GET fit the
 * input schema of each tool. Joshu pins the Google Calendar toolkit to version 20261009_00
 * (googleCalendarConfig.ts). That version rejects unknown keys ("Extra inputs are not permitted").
 *
 * The property lists below are from GET https://backend.composio.dev/api/v3/tools/<SLUG>
 * (version 20261009_00, additionalProperties false).
 *
 * Usage: npm run test:composio-calendar-args
 */
import assert from "node:assert/strict";

import { buildEventsListAllCalendarsArgs } from "../src/connectors/composio/calendar.js";
import {
  buildCreateEventArgs,
  buildEventsGetArgs,
  buildPatchEventArgs,
} from "../src/connectors/composio/calendarOwner.js";
import { COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION } from "../src/connectors/composio/googleCalendarConfig.js";

const SCHEMA_20261009_00 = {
  required: ["time_min", "time_max"],
  properties: [
    "q",
    "time_max",
    "time_min",
    "event_types",
    "calendar_ids",
    "show_deleted",
    "single_events",
    "response_detail",
    "max_results_per_calendar",
  ],
};

if (!process.env.JOSHU_COMPOSIO_GOOGLECALENDAR_VERSION?.trim()) {
  assert.equal(
    COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION,
    "20261009_00",
    "the pin changed: check the arguments against the schema of the new version and update this test",
  );
}

const timeMin = "2026-10-08T00:00:00.000Z";
const timeMax = "2026-10-23T00:00:00.000Z";
const args = buildEventsListAllCalendarsArgs(timeMin, timeMax);

for (const key of Object.keys(args)) {
  assert.ok(
    SCHEMA_20261009_00.properties.includes(key),
    `argument ${key} is not in the Composio schema; Composio rejects it`,
  );
}
for (const key of SCHEMA_20261009_00.required) {
  assert.ok(key in args, `required argument ${key} is missing`);
}
assert.equal(args.time_min, timeMin);
assert.equal(args.time_max, timeMax);
assert.equal(args.response_detail, "full");
assert.ok(!("max_results" in args), "max_results is not a parameter of this tool");
assert.ok(
  !("max_results_per_calendar" in args),
  "do not cap per calendar: Google returns events in no fixed order, so a cap can drop events",
);

// --- Owner calendar event tools ---

const CREATE_EVENT_PROPERTIES = [
  "attendees", "birthdayProperties", "calendar_id", "create_meeting_room", "description", "end_date",
  "end_datetime", "eventType", "event_duration_hour", "event_duration_minutes", "exclude_organizer",
  "extended_properties", "focusTimeProperties", "guestsCanInviteOthers", "guestsCanModify",
  "guestsCanSeeOtherGuests", "location", "outOfOfficeProperties", "recurrence", "send_updates", "start_date",
  "start_datetime", "summary", "timezone", "transparency", "visibility", "workingLocationProperties",
];
const PATCH_EVENT_PROPERTIES = [
  "anyone_can_add_self", "attachments", "attendees", "attendees_omitted", "calendar_id", "color_id",
  "conference_data", "conference_data_version", "description", "end_time", "event_id", "extended_properties",
  "focus_time_properties", "guests_can_invite_others", "guests_can_modify", "guests_can_see_other_guests",
  "location", "max_attendees", "out_of_office_properties", "recurrence", "reminders", "rsvp_response",
  "send_updates", "sequence", "source", "start_time", "status", "summary", "supports_attachments", "timezone",
  "transparency", "visibility", "working_location_properties",
];
const EVENTS_GET_PROPERTIES = ["calendar_id", "event_id", "max_attendees", "time_zone"];

function assertFitsSchema(tool, args, properties, required = []) {
  for (const key of Object.keys(args)) {
    assert.ok(properties.includes(key), `${tool}: argument ${key} is not in the Composio schema; Composio rejects it`);
  }
  for (const key of required) assert.ok(key in args, `${tool}: required argument ${key} is missing`);
}

const fullInput = {
  calendarId: "owner@example.com",
  summary: "Demo",
  start: "2026-10-15T11:00:00",
  end: "2026-10-15T11:30:00",
  timezone: "America/Los_Angeles",
  attendees: ["guest@example.com"],
  description: "Agenda",
  location: "",
  sendUpdates: "all",
  transparency: "opaque",
};
assertFitsSchema("GOOGLECALENDAR_CREATE_EVENT", buildCreateEventArgs("owner@example.com", fullInput), CREATE_EVENT_PROPERTIES);

const patchWithMeet = buildPatchEventArgs("owner@example.com", "evt1", fullInput, "req-1");
assertFitsSchema("GOOGLECALENDAR_PATCH_EVENT", patchWithMeet, PATCH_EVENT_PROPERTIES, ["calendar_id", "event_id"]);
// Schema ConferenceDataInput: createRequest { requestId, conferenceSolutionKey { type } }, no other keys.
assert.deepEqual(patchWithMeet.conference_data, {
  createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } },
});
assert.equal(patchWithMeet.conference_data_version, 1);

assertFitsSchema(
  "GOOGLECALENDAR_EVENTS_GET",
  buildEventsGetArgs("owner@example.com", "evt1", "America/Los_Angeles"),
  EVENTS_GET_PROPERTIES,
  ["event_id"],
);

console.log("test-composio-calendar-args: ok");
