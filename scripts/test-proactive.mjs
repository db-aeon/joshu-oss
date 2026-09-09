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
  parseFeedbackKeyword,
  parseTaskActionKeyword,
} from "../src/proactive/feedback.js";
import { ensureCadenceHintLine, PROACTIVE_CADENCE_HINT } from "../src/proactive/composeMessage.js";
import { isWithinProactiveWindow, parseMinutesSinceMidnight } from "../src/proactive/workingHours.js";
import {
  canSendNudge,
  factoryProactiveState,
  rolloverProactiveState,
} from "../src/proactive/state.js";
import { applySentNudge } from "../src/proactive/tick.js";
import { extractHardDates, isDateStaleForNudge } from "../src/proactive/stale.js";
import { rankCandidate, isProjectActiveForNudge } from "../src/proactive/prioritize.js";
import { extractSchedulingTaskIdsFromText } from "../src/proactive/schedulingHandoff.js";
import { proactiveResolveSessionKey, buildProactiveResolveSystemMessage } from "../src/proactive/resolveOwnerReply.js";
import { normalizeKanbanCreatedAtMs } from "../src/proactive/crossBoardKanban.js";
import { sortHygieneCandidates } from "../src/proactive/hygienePrepare.js";
import { pickTopStaleReviewCandidate, recordHygieneRun } from "../src/proactive/hygieneRecord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// kanban created_at normalization
{
  assert.equal(normalizeKanbanCreatedAtMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(normalizeKanbanCreatedAtMs(1_700_000_000_000), 1_700_000_000_000);
}

// hygiene sort: date-stale before non-stale
{
  const sorted = sortHygieneCandidates([
    {
      board: "ea-scheduling",
      task_id: "t_new",
      title: "Active follow-up",
      status: "blocked",
      created_at_ms: Date.UTC(2026, 8, 1),
    },
    {
      board: "ea-scheduling",
      task_id: "t_old",
      title: "Interview Aug 12, 2025",
      status: "blocked",
      created_at_ms: Date.UTC(2026, 0, 1),
    },
  ]);
  assert.equal(sorted[0]?.task_id, "t_old");
}

// hygiene record + stale_review queue
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-hygiene-"));
  const state = recordHygieneRun(root, {
    closedTaskIds: ["t_done"],
    ambiguous: [{ taskId: "t_maybe", board: "project-x", title: "Stale?" }],
    skipped: 1,
    active: 2,
  });
  assert.ok(state.hygieneLastRunAt);
  assert.ok(state.hygieneClosedTaskIds?.includes("t_done"));
  assert.equal(state.hygieneAmbiguousQueue?.length, 1);
  const stale = pickTopStaleReviewCandidate(state);
  assert.equal(stale?.taskId, "t_maybe");
  fs.rmSync(root, { recursive: true, force: true });
}

// feedback keywords — short fuzzy replies
{
  assert.equal(parseFeedbackKeyword("MORE"), "MORE");
  assert.equal(parseFeedbackKeyword("more please"), "MORE");
  assert.equal(parseFeedbackKeyword("yeah useful"), "USEFUL");
  assert.equal(parseFeedbackKeyword("Tell me more about the scheduling thread please"), null);
}

// cadence hint appended to nudges
{
  const withRef = ensureCadenceHintLine("Hey Dan — quick one.\nRef: pj/t_abc", "nudge");
  assert.ok(withRef.includes(PROACTIVE_CADENCE_HINT));
  assert.ok(withRef.indexOf(PROACTIVE_CADENCE_HINT) < withRef.indexOf("Ref:"));
}

// project about.md status gates hourly nudges
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-nudge-status-"));
  const filesRoot = path.join(root, "files");
  const proj = path.join(filesRoot, "Projects", "google-labs-gpm");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "about.md"), "---\nstatus: done\n---\n");
  assert.equal(isProjectActiveForNudge(filesRoot, "google-labs-gpm"), false);
  fs.writeFileSync(path.join(proj, "about.md"), "|---\n|status: active\n---\n");
  assert.equal(isProjectActiveForNudge(filesRoot, "google-labs-gpm"), true);
  assert.equal(isProjectActiveForNudge(filesRoot, "missing-slug"), true);
  assert.equal(isProjectActiveForNudge(filesRoot, undefined), true);
  fs.rmSync(root, { recursive: true, force: true });
}

// proactive resolve asks for project-slug reconcile on project boards
{
  const msg = buildProactiveResolveSystemMessage(
    { taskId: "t_ae1c68af", board: "project-google-labs-gpm", title: "Jaclyn" },
    "they rejected me",
  );
  assert.ok(msg.content.includes("Project reconcile"));
  assert.ok(msg.content.includes("mail_list_track_tasks"));
  const sched = buildProactiveResolveSystemMessage(
    { taskId: "t_meet", board: "ea-scheduling" },
    "ok send it",
  );
  assert.equal(sched.content.includes("Project reconcile"), false);
}

console.log("proactive: all tests passed");
