#!/usr/bin/env npx tsx
/**
 * Unit tests: proactive Joshu (block reasons, working hours, feedback, state, stale dates).
 *
 * Usage: npm run test:proactive
 */
import assert from "node:assert/strict";

import { blockReasonNeedsOwnerInput, parseProactiveTaskRef } from "../src/proactive/blockReason.js";
import {
  applyProactiveFeedbackKeyword,
  parseTaskActionKeyword,
} from "../src/proactive/feedback.js";
import { isWithinProactiveWindow, parseMinutesSinceMidnight } from "../src/proactive/workingHours.js";
import {
  canSendNudge,
  factoryProactiveState,
  rolloverProactiveState,
} from "../src/proactive/state.js";
import { applySentNudge } from "../src/proactive/tick.js";
import { extractHardDates, isDateStaleForNudge } from "../src/proactive/stale.js";
import { rankCandidate } from "../src/proactive/prioritize.js";
import { extractSchedulingTaskIdsFromText } from "../src/proactive/schedulingHandoff.js";
import { proactiveResolveSessionKey } from "../src/proactive/resolveOwnerReply.js";

const defaultPrefs = {
  allowMorePerDay: false,
  allowEvenings: false,
  allowWeekends: false,
  offHoursAskedAt: null,
  notes: [],
};

// block_reason filter
{
  assert.equal(blockReasonNeedsOwnerInput("awaiting owner approval"), true);
  assert.equal(blockReasonNeedsOwnerInput("awaiting owner or external party"), true);
  assert.equal(blockReasonNeedsOwnerInput("owner review: scheduling judgment"), true);
  assert.equal(blockReasonNeedsOwnerInput("awaiting reply: counterparty"), false);
  assert.equal(blockReasonNeedsOwnerInput("connectors-mcp-down: x"), false);
}

// task ref parse
{
  assert.deepEqual(parseProactiveTaskRef("ok Ref: pj/t_abc123 thanks"), { taskId: "t_abc123" });
  assert.equal(parseProactiveTaskRef("no ref here"), null);
}

// task action keywords
{
  assert.equal(parseTaskActionKeyword("DONE"), "DONE");
  assert.equal(parseTaskActionKeyword("  close "), "CLOSE");
  assert.equal(parseTaskActionKeyword("maybe keep"), null);
}

// working hours
{
  assert.equal(parseMinutesSinceMidnight("09:30"), 9 * 60 + 30);
  const prefs = defaultPrefs;
  const weekdayMid = isWithinProactiveWindow(
    { timezone: "America/Los_Angeles", workingHoursStart: "09:00", workingHoursEnd: "17:00" },
    prefs,
  );
  assert.equal(weekdayMid.ok, true, "weekday midday should be ok when evaluated at current time if in window");
}

// daily cap
{
  let state = factoryProactiveState("2026-09-07");
  assert.equal(canSendNudge(state).ok, true);
  state = applySentNudge(state, {
    taskId: "t_x",
    board: "ea-scheduling",
    sentAt: new Date().toISOString(),
    channel: "sms",
  });
  assert.equal(state.sentCount, 1);
  assert.equal(canSendNudge(state).ok, false);
}

// date rollover
{
  const state = factoryProactiveState("2026-09-06");
  state.sentCount = 3;
  const rolled = rolloverProactiveState(state, "2026-09-07");
  assert.equal(rolled.date, "2026-09-07");
  assert.equal(rolled.sentCount, 0);
  assert.equal(rolled.dailyCap, 1);
}

// feedback keywords (sync apply — no Hermes compose)
{
  const fb = applyProactiveFeedbackKeyword("MORE");
  assert.equal(fb.ok, true);
  assert.equal(fb.state?.preferences.allowMorePerDay, true);
}

// stale date extraction + nudge exclusion
{
  const dates = extractHardDates("Interview Aug 12, 2025 — follow up");
  assert.ok(dates.length >= 1);
  const aug2025 = Date.UTC(2025, 7, 12, 12, 0, 0);
  assert.ok(dates.includes(aug2025));
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);
  assert.equal(isDateStaleForNudge("Interview Aug 12, 2025", now, 14), true);
  assert.equal(isDateStaleForNudge("No dates in title", now, 14), false);
}

// overdue tasks rank lower priority than upcoming (higher score)
{
  const filesRoot = "/tmp/proactive-test-files";
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);
  const overdue = rankCandidate(
    {
      taskId: "t_old",
      board: "project-foo",
      title: "Interview Aug 12, 2025",
      blockReason: "awaiting owner",
      projectSlug: "foo",
    },
    filesRoot,
  );
  const upcoming = rankCandidate(
    {
      taskId: "t_soon",
      board: "project-foo",
      title: "Deadline 2026-09-10",
      blockReason: "awaiting owner",
      projectSlug: "foo",
    },
    filesRoot,
  );
  assert.ok(
    overdue.rankScore > upcoming.rankScore,
    `overdue (${overdue.rankScore}) should rank worse than upcoming (${upcoming.rankScore})`,
  );
}

// scheduling handoff task id extraction
{
  const ids = extractSchedulingTaskIdsFromText(
    "See ea-scheduling t_daa6bce0 and thread_id: abc",
  );
  assert.deepEqual(ids, ["t_daa6bce0"]);
}

// dedicated resolve session keys (not SMS sticky session)
{
  assert.equal(proactiveResolveSessionKey("t_abc"), "proactive:resolve:t_abc");
  assert.equal(proactiveResolveSessionKey(""), "proactive:resolve:unknown");
}

console.log("proactive: all tests passed");
