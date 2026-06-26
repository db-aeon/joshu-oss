#!/usr/bin/env npx tsx
/**
 * Slot parsing for Nylas calendar MCP (local date/time + IANA TZ → epoch).
 *
 * Usage: npm run test:local-slot
 */
import {
  localDateDayBounds,
  localDateTimeToEpochSeconds,
  resolveEventWindow,
  resolveListEventsWindow,
} from "../src/nylas/localSlot.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tz = "America/Los_Angeles";
const date = "2026-06-08";

const start = localDateTimeToEpochSeconds(date, "17:00", tz);
const end = localDateTimeToEpochSeconds(date, "18:00", tz);
assert(start === 1780963200, `start epoch expected 1780963200 got ${start}`);
assert(end === 1780966800, `end epoch expected 1780966800 got ${end}`);

const day = localDateDayBounds(date, tz);
assert(day.start === 1780902000, `day start expected 1780902000 got ${day.start}`);
assert(day.end === 1780988399, `day end expected 1780988399 got ${day.end}`);

const fromLocal = resolveEventWindow({
  date,
  startLocal: "17:00",
  endLocal: "18:00",
  timezone: tz,
});
assert(fromLocal.resolvedFrom === "local_slot", "expected local_slot resolution");
assert(fromLocal.startTime === start && fromLocal.endTime === end, "local slot window mismatch");

const fromEpoch = resolveEventWindow({ startTime: start, endTime: end, timezone: tz });
assert(fromEpoch.resolvedFrom === "epoch", "expected epoch resolution");

const listWindow = resolveListEventsWindow({ date, timezone: tz });
assert(listWindow.resolvedFrom === "local_slot", "expected list local_slot");
assert(listWindow.start === day.start && listWindow.end === day.end, "list window mismatch");

console.log("test-local-slot: ok");
