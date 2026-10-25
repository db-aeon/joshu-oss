#!/usr/bin/env npx tsx
/**
 * Unit tests: proactive Joshu (block reasons, working hours, feedback, state, stale dates).
 *
 * Usage: npm run test:proactive
 */
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";

import { parseProactiveTaskRef } from "../src/proactive/blockReason.js";
import {
  applyProactiveFeedbackKeyword,
  parseFeedbackKeyword,
  parseTaskActionKeyword,
} from "../src/proactive/feedback.js";
import {
  buildComposeUserPrompt,
  ensureCadenceHintLine,
  PROACTIVE_CADENCE_HINT,
  proactiveComposeSessionKey,
  setProactiveHermesRunner,
} from "../src/proactive/composeMessage.js";
import { deliverProactiveNudge } from "../src/proactive/delivery.js";
import { ownerTextChannelFor } from "../src/ownerTextChannel.js";
import { isWithinProactiveWindow, parseMinutesSinceMidnight } from "../src/proactive/workingHours.js";
import {
  canSendNudge,
  factoryProactiveState,
  rolloverProactiveState,
} from "../src/proactive/state.js";
import { applySentNudge, runProactiveTick } from "../src/proactive/tick.js";
import { extractHardDates, isDateStaleForNudge } from "../src/proactive/stale.js";
import { rankCandidate, isProjectActiveForNudge } from "../src/proactive/prioritize.js";
import { extractSchedulingTaskIdsFromText } from "../src/proactive/schedulingHandoff.js";
import { proactiveResolveSessionKey, buildProactiveResolveSystemMessage } from "../src/proactive/resolveOwnerReply.js";
import {
  shouldRouteOwnerReplyToProactiveResolve,
  resolveProactiveFollowUpWindowMs,
} from "../src/proactive/ownerReplyRouting.js";
import { resolveSmsHermesTimeoutMs, SMS_HERMES_TIMEOUT_MS_DEFAULT } from "../src/twilioSmsConfig.js";
import { normalizeKanbanCreatedAtMs } from "../src/proactive/crossBoardKanban.js";
import { isOwnerQuestion, toProactiveCandidate } from "../src/proactive/sweep.js";
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
    // Tuesday 2026-10-06 12:00 in Los Angeles. A fixed time keeps the test independent of the clock.
    Temporal.Instant.from("2026-10-06T19:00:00Z"),
  );
  assert.equal(weekdayMid.ok, true, "weekday midday should be ok");
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
      // rankCandidate uses the real clock, so the deadline is 3 days after today.
      title: `Deadline ${new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)}`,
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
  const withRef = ensureCadenceHintLine("Hey Sam — quick one.\nRef: pj/t_abc", "nudge");
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

// proactive follow-up routing (second SMS after first resolve)
{
  const nudgeAt = "2026-09-14T16:00:32.710Z";
  const replyAt = "2026-09-14T18:20:00.000Z";
  const base = {
    ...factoryProactiveState("2026-09-14"),
    lastNudge: {
      taskId: "t_b590a811",
      board: "project-joshu-venture-investing",
      sentAt: nudgeAt,
      channel: "sms",
    },
    feedbackPending: false,
    lastOwnerReplyAt: replyAt,
  };
  const nowInside = Date.parse(replyAt) + 30 * 60_000;
  assert.equal(
    shouldRouteOwnerReplyToProactiveResolve(base, "Nah, most of those are Spam really", {
      nowMs: nowInside,
    }),
    true,
    "follow-up within window should route to proactive resolve",
  );
  const windowMs = resolveProactiveFollowUpWindowMs();
  const nowOutside = Date.parse(replyAt) + windowMs + 60_000;
  assert.equal(
    shouldRouteOwnerReplyToProactiveResolve(base, "random chat", { nowMs: nowOutside }),
    false,
    "unrelated text after follow-up window should not hijack proactive router",
  );
  assert.equal(
    shouldRouteOwnerReplyToProactiveResolve(
      { ...base, feedbackPending: true },
      "first reply",
      { nowMs: nowInside },
    ),
    true,
    "feedbackPending still routes first reply",
  );
}

// SMS Hermes timeout default bumped from 180s
{
  const prev = process.env.JOSHU_SMS_HERMES_TIMEOUT_MS;
  delete process.env.JOSHU_SMS_HERMES_TIMEOUT_MS;
  assert.equal(resolveSmsHermesTimeoutMs(), SMS_HERMES_TIMEOUT_MS_DEFAULT);
  assert.equal(SMS_HERMES_TIMEOUT_MS_DEFAULT, 300_000);
  if (prev !== undefined) process.env.JOSHU_SMS_HERMES_TIMEOUT_MS = prev;
}

// Requirement "No clarify questions" (change proactive-clarify-hardening, spec owner-nudge):
// a proactive state file from an earlier version has a clarify queue entry.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-no-clarify-"));
  const user = "owner@example.com";
  const userDir = path.join(root, ".local", "arozos-data", "files", "users", user);
  fs.mkdirSync(path.join(userDir, "Desktop", "joshu's files"), { recursive: true });
  fs.mkdirSync(path.join(userDir, ".joshu", "nylas"), { recursive: true });
  // Working hours cover the whole day, so the test does not depend on the clock.
  fs.writeFileSync(
    path.join(userDir, ".joshu", "nylas", "profile.json"),
    JSON.stringify({ timezone: "America/Los_Angeles", workingHoursStart: "00:00", workingHoursEnd: "23:59" }),
  );
  const stateFile = path.join(root, ".joshu", "proactive", "state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const oldState = {
    ...factoryProactiveState("2026-10-05"),
    preferences: { allowMorePerDay: false, allowEvenings: true, allowWeekends: true, offHoursAskedAt: null, notes: [] },
    clarifyQueue: [
      {
        taskId: "t_x",
        board: "project-st-mary",
        title: "Owner decision: Grade 5 RE",
        blockReason: "awaiting owner or external party",
        conflict: "New mail filed but card still open — close it?",
        handoffAt: "2026-08-27T17:51:43.042Z",
        queuedAt: "2026-08-27T17:51:44.000Z",
      },
    ],
  };
  fs.writeFileSync(stateFile, JSON.stringify(oldState));
  const env = { AROZ_DATA: process.env.AROZ_DATA, HERMES_HOME: process.env.HERMES_HOME, JOSHU_AROZ_USER: process.env.JOSHU_AROZ_USER };
  delete process.env.AROZ_DATA;
  delete process.env.JOSHU_AROZ_USER;
  process.env.HERMES_HOME = path.join(root, "hermes-empty");
  try {
    const result = await runProactiveTick({ projectRoot: root });
    assert.equal(result.action, "skipped", JSON.stringify(result));
    assert.equal(result.reason, "no_candidates", JSON.stringify(result));
    const written = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal("clarifyQueue" in written, false);
  } finally {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Requirement "Block kind decides an owner question" (change proactive-clarify-hardening, spec owner-nudge).
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-owner-question-"));
  const filesRoot = path.join(root, "files");
  fs.mkdirSync(filesRoot, { recursive: true });
  const contactBody = `kind: mail_track
project_slug: acme-partnerships
mail_handoff:
  message_id: eb6a9b0e
  source_path: connectors/mail/nylas/threads/0e70.md
  summary: "Confirms he wants the referral link Ava followed up about."`;
  const contactTrack = {
    task_id: "t_0c0ffee1",
    title: "Riley Contact — billing card + referral interest",
    status: "blocked",
    body: contactBody,
    block_reason: "awaiting owner — send Riley Contact the referral link and code",
    block_kind: "needs_input",
    created_at_ms: Date.now() - 3_600_000,
  };

  // Scenario "Block kind is needs_input", and requirement "Proactive sweep ignores the content of emails":
  // the handoff summary contains "Confirms", and the mail mirror contains "confirmed".
  fs.mkdirSync(path.join(filesRoot, "connectors/mail/nylas/threads"), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, "connectors/mail/nylas/threads/0e70.md"), "You are confirmed.\n");
  const selected = await toProactiveCandidate(contactTrack, "project-acme-partnerships", filesRoot, root);
  assert.equal(selected?.taskId, "t_0c0ffee1");

  // Scenario "Generic block reason without a block kind".
  const generic = { ...contactTrack, task_id: "t_generic", block_reason: "awaiting owner or external party", block_kind: null };
  assert.equal(isOwnerQuestion(generic), false);
  assert.equal(await toProactiveCandidate(generic, "project-other", filesRoot, root), null);

  // Requirement "Realtime-goal broker owns its questions" — scenario "Owner question on board realtime-goals".
  assert.equal(await toProactiveCandidate(contactTrack, "realtime-goals", filesRoot, root), null);

  // Scenario "Block reason text does not match an owner pattern".
  assert.equal(
    isOwnerQuestion({ status: "blocked", block_kind: "needs_input", block_reason: "Chase drafted but cannot be sent from this worker" }),
    true,
  );

  // Scenario "Other block kinds".
  for (const kind of ["transient", "capability", "dependency"]) {
    assert.equal(isOwnerQuestion({ status: "blocked", block_kind: kind }), false, kind);
  }
  assert.equal(isOwnerQuestion({ status: "ready", block_kind: "needs_input" }), false);
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

// Change proactive-nudge-channel, spec owner-nudge: no compose without a route,
// the compose names the channel, and each compose gets its own Hermes session.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-channel-"));
  const user = "owner@example.com";
  const userDir = path.join(root, ".local", "arozos-data", "files", "users", user);
  fs.mkdirSync(path.join(userDir, "Desktop", "joshu's files"), { recursive: true });
  const nylasDir = path.join(userDir, ".joshu", "nylas");
  fs.mkdirSync(nylasDir, { recursive: true });
  fs.writeFileSync(path.join(nylasDir, "profile.json"), JSON.stringify({ timezone: "Asia/Taipei" }));
  const envKeys = [
    "AROZ_DATA",
    "JOSHU_AROZ_USER",
    "JOSHU_OWNER_EMAIL",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_OWNER_CALLER",
  ];
  const env = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  let hermesCalls = 0;
  setProactiveHermesRunner({
    ensureGatewayReady: async () => {},
    streamHermesChat: async () => {
      hermesCalls += 1;
      return { finalText: "unused" };
    },
  });
  const candidate = {
    taskId: "t_dade00f1",
    board: "ea-onboarding",
    title: "Connect your work calendar",
    status: "blocked",
    blockReason: "awaiting owner",
    rankScore: 1,
    rankSignals: {},
  };
  try {
    // Scenario "Box without an owner mobile and without an email route".
    assert.equal(ownerTextChannelFor(root), null);
    const none = await deliverProactiveNudge({ candidate, projectRoot: root });
    assert.deepEqual(none, { delivered: false, error: "no_delivery_channel" });
    assert.equal(hermesCalls, 0);

    // With a primary work email and a companion mailbox, the channel is email.
    fs.writeFileSync(
      path.join(nylasDir, "profile.json"),
      JSON.stringify({ timezone: "Asia/Taipei", primaryWorkEmail: user }),
    );
    fs.writeFileSync(
      path.join(nylasDir, "agent.json"),
      JSON.stringify({ grantId: "g_1", email: "companion@example.com" }),
    );
    assert.equal(ownerTextChannelFor(root), "email");

    // Scenario "Nudge by email".
    const emailPrompt = buildComposeUserPrompt({ kind: "nudge", projectRoot: root, candidate, channel: "email" });
    assert.match(emailPrompt, /^Compose an outbound email to the box owner/);
    assert.match(emailPrompt, /Output ONLY the email body text\.$/);
    assert.doesNotMatch(emailPrompt, /SMS body/);
    assert.equal(
      ensureCadenceHintLine("Hi.\nRef: pj/t_dade00f1", "nudge", "email"),
      "Hi.\nRef: pj/t_dade00f1",
    );

    // Scenario "Nudge by SMS" keeps the SMS wording and the cadence hint.
    const smsPrompt = buildComposeUserPrompt({ kind: "nudge", projectRoot: root, candidate, channel: "sms" });
    assert.match(smsPrompt, /^Compose an outbound SMS to the box owner/);
    assert.match(smsPrompt, /MORE\/LESS\/USEFUL/);
    assert.ok(ensureCadenceHintLine("Hi.", "nudge", "sms").includes(PROACTIVE_CADENCE_HINT));

    // Scenario "Two composes on the same day".
    const first = proactiveComposeSessionKey({ kind: "nudge", candidate }, new Date("2026-10-14T01:00:00Z"));
    const second = proactiveComposeSessionKey({ kind: "nudge", candidate }, new Date("2026-10-14T02:00:00Z"));
    assert.notEqual(first, second);
    assert.ok(first.includes("t_dade00f1"));
  } finally {
    setProactiveHermesRunner(null);
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("proactive: all tests passed");
