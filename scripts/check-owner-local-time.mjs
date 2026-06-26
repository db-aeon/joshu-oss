#!/usr/bin/env node
/**
 * Regression: owner-local clock anchor and calendar relative-day labels.
 * Usage: npm run test:owner-local-time
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  getOwnerTimeAnchor,
  relativeDayLabel,
  eventLocalDate,
  enrichCalendarEventsWithTimeContext,
} = await import(pathToFileURL(path.join(rootDir, "dist/ownerLocalTime.js")).href);

// Trace c7742f82: Tue 2026-06-16 ~5:16 PM PT — model wrongly called Wed 6/17 "today".
const anchor = getOwnerTimeAnchor(rootDir, new Date("2026-06-17T00:16:14.274Z"));

if (anchor.localDate !== "2026-06-16") {
  console.error(`FAIL anchor date: got ${anchor.localDate}, want 2026-06-16`);
  process.exit(1);
}
if (anchor.weekday !== "Tuesday") {
  console.error(`FAIL anchor weekday: got ${anchor.weekday}, want Tuesday`);
  process.exit(1);
}

if (relativeDayLabel("2026-06-17", anchor) !== "tomorrow") {
  console.error("FAIL Wed 6/17 should be tomorrow relative to Tue 6/16 evening PT");
  process.exit(1);
}
if (relativeDayLabel("2026-06-16", anchor) !== "today") {
  console.error("FAIL Tue 6/16 should be today");
  process.exit(1);
}
if (relativeDayLabel("2026-06-15", anchor) !== "yesterday") {
  console.error("FAIL Mon 6/15 should be yesterday");
  process.exit(1);
}
if (relativeDayLabel("2026-06-22", anchor) !== null) {
  console.error("FAIL next Mon should have no relativeDay label");
  process.exit(1);
}

const jaclynStart = "2026-06-17T15:00:00-07:00";
if (eventLocalDate(jaclynStart, anchor.timezone) !== "2026-06-17") {
  console.error("FAIL eventLocalDate for Jaclyn Connect call");
  process.exit(1);
}

const enriched = enrichCalendarEventsWithTimeContext(
  [{ summary: "Connect — Jaclyn Clark", start: jaclynStart }],
  anchor.timezone,
  anchor,
);
if (enriched[0]?.relativeDay !== "tomorrow") {
  console.error(`FAIL enriched relativeDay: got ${enriched[0]?.relativeDay}, want tomorrow`);
  process.exit(1);
}

console.log("OK: owner-local time anchor and relative-day labels");
