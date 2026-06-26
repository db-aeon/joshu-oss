import assert from "node:assert/strict";
import {
  combineCalendarFreeBusy,
  isSchedulableEmailCalendarId,
} from "../dist/connectors/composio/calendarAvailability.js";

assert.equal(isSchedulableEmailCalendarId("dbenyamin@gmail.com"), true);
assert.equal(isSchedulableEmailCalendarId("en.usa#holiday@group.v.calendar.google.com"), false);

const combined = combineCalendarFreeBusy(
  {
    primary: {
      busy: [],
      free: [{ start: "2026-06-25T07:00:00.000Z", end: "2026-06-26T06:59:59.000Z" }],
    },
    "dbenyamin@gmail.com": {
      busy: [
        { start: "2026-06-25T14:30:00-07:00", end: "2026-06-25T17:30:00-07:00" },
      ],
      free: [
        { start: "2026-06-25T08:30:00-07:00", end: "2026-06-25T14:30:00-07:00" },
      ],
    },
  },
  "2026-06-25T07:00:00.000Z",
  "2026-06-26T06:59:59.000Z",
);

assert.equal(combined.busy.length, 1);
assert.ok(combined.busy[0].start.includes("14:30"));
assert.ok(
  combined.free.some((interval) => {
    const start = Date.parse(interval.start);
    const end = Date.parse(interval.end);
    return start <= Date.parse("2026-06-25T21:00:00.000Z") && end >= Date.parse("2026-06-25T21:15:00.000Z");
  }),
  "2:00 PM PT should remain in combined.free",
);
assert.ok(
  !combined.free.some((interval) => {
    const start = Date.parse(interval.start);
    const end = Date.parse(interval.end);
    return start <= Date.parse("2026-06-25T22:00:00.000Z") && end > Date.parse("2026-06-25T22:00:00.000Z");
  }),
  "3:00 PM PT should not be in combined.free",
);

console.log("test-calendar-availability: ok");
