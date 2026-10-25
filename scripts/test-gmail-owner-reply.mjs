#!/usr/bin/env npx tsx
/**
 * Unit tests: Gmail thread decision and handoff of an owner Gmail reply
 * (spec gmail-sync, OpenSpec change gmail-owner-reply-handoff).
 * A fake Kanban bridge replaces hermes-kanban-bridge.py.
 *
 * Usage: npm run test:gmail-owner-reply
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gmailThreadIngestKind, isGmailJunk, isGmailSkippedMessage } from "../src/ea/gmailJunk.js";
import { findOpenMailTracksByThreadOnBoards } from "../src/ea/mailCron.js";
import { handoffOwnerGmailReply, shouldHandoffOwnerGmailReply } from "../src/ea/ownerGmailReply.js";

const THREAD_ID = "1a10c823830494eb";
const REPLY_ID = "1a11ddc14be57e4d";
const COMPANION = "companion@example.com";

const msg = (...labelIds) => ({ labelIds });

// Requirement "The Gmail sync decides from the whole thread".
{
  // Scenario "The owner answers an external sender": labels of a real thread on a fleet box, 2026-10-09.
  const sra = [
    msg("SENT"),
    msg("YELLOW_STAR", "IMPORTANT", "STARRED", "CATEGORY_PERSONAL", "INBOX"),
    msg("SENT"),
    msg("IMPORTANT", "CATEGORY_PERSONAL", "INBOX"),
    msg("SENT"),
  ];
  assert.deepEqual(gmailThreadIngestKind(sra), { kind: "owner_reply" });

  // Scenario "A thread with only outgoing messages".
  assert.deepEqual(gmailThreadIngestKind([msg("SENT"), msg("SENT")]), { kind: "skip", label: "SENT" });

  // Scenario "A draft reply is the newest message".
  assert.deepEqual(gmailThreadIngestKind([msg("INBOX"), msg("DRAFT")]), { kind: "skip", label: "DRAFT" });
  assert.deepEqual(gmailThreadIngestKind([msg("INBOX"), msg("SENT", "OUTBOX")]), { kind: "skip", label: "OUTBOX" });

  // Scenario "The owner answers a newsletter".
  assert.deepEqual(
    gmailThreadIngestKind([msg("INBOX", "CATEGORY_UPDATES"), msg("SENT")]),
    { kind: "skip", label: "SENT" },
  );

  // Scenario "A new inbound message", and a bulk label on the newest message.
  assert.deepEqual(gmailThreadIngestKind([msg("SENT"), msg("INBOX", "UNREAD")]), { kind: "inbound" });
  assert.deepEqual(
    gmailThreadIngestKind([msg("INBOX", "CATEGORY_PROMOTIONS")]),
    { kind: "skip", label: "CATEGORY_PROMOTIONS" },
  );

  // Pre-filter on single messages keeps SENT; the triage gate still skips SENT.
  assert.equal(isGmailSkippedMessage(["SENT"]), false);
  assert.equal(isGmailSkippedMessage(["DRAFT"]), true);
  assert.equal(isGmailSkippedMessage(["INBOX", "SPAM"]), true);
  assert.equal(isGmailJunk(["SENT"]), true);
}

/** Fake Kanban bridge over tasks on several boards. Records each payload. */
function fakeBridge(tasks) {
  const calls = [];
  const bridge = async (payload) => {
    calls.push(payload);
    const task = tasks.find((t) => t.task_id === payload.task_id && t.board === payload.board);
    switch (payload.action) {
      case "find_open_by_text":
        return {
          success: true,
          tasks: tasks
            .filter((t) => payload.boards.includes(t.board) && payload.statuses.includes(t.status))
            .filter((t) => t.body.includes(payload.text))
            .map((t) => ({ ...t })),
        };
      case "show":
        return task ? { success: true, task: { ...task } } : { success: false, error: "task_not_found" };
      case "append_body":
        task.body += `\n${payload.append}`;
        return { success: true };
      case "comment":
        return { success: true };
      case "unblock":
        task.status = "ready";
        return { success: true, action_taken: "unblocked" };
      default:
        throw new Error(`unexpected Kanban bridge action ${payload.action}`);
    }
  };
  return { bridge, calls };
}

const BOARDS = ["ea-mail-ingress", "project-personal-tax-2025", "project-other", "realtime-goals"];

function taxTrack(status = "blocked", extraBody = "") {
  return {
    task_id: "t_9ebcc66f",
    board: "project-personal-tax-2025",
    title: "Conference call re: Assessment",
    status,
    body: `kind: mail_track\nthread_id: ${THREAD_ID}\nsubject: "RE: Assessment"${extraBody}`,
  };
}

const filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-owner-reply-"));
const input = {
  filesRoot,
  projectRoot: filesRoot,
  threadId: THREAD_ID,
  sourcePath: `connectors/mail/gmail/owner_at_example_com/threads/${THREAD_ID}.md`,
  messageId: REPLY_ID,
  from: "Owner Name <owner@example.com>",
  to: ["CPA Firm <cpa@example.com>"],
  accountEmail: "owner@example.com",
};
const deps = (bridge) => ({ bridge, boards: BOARDS, agentEmails: new Set([COMPANION]) });

// One bridge call for project boards only; thread match only; no ingress task.
{
  const tasks = [
    taxTrack(),
    {
      task_id: "t_other01",
      board: "project-other",
      status: "blocked",
      body: `kind: mail_track\nsource_paths:\n  - connectors/mail/gmail/x/threads/${THREAD_ID}.md`,
    },
    { task_id: "t_prose01", board: "project-other", status: "blocked", body: `kind: project\nnote: id ${THREAD_ID}x` },
    { task_id: "t_ingress", board: "project-other", status: "ready", body: `kind: mail_ingress\nthread_id: ${THREAD_ID}` },
    { task_id: "t_done001", board: "project-other", status: "done", body: `kind: mail_track\nthread_id: ${THREAD_ID}` },
  ];
  const fake = fakeBridge(tasks);
  const found = await findOpenMailTracksByThreadOnBoards(THREAD_ID, BOARDS, fake.bridge);
  assert.deepEqual(found.map((t) => t.task_id).sort(), ["t_9ebcc66f", "t_other01"]);
  assert.equal(found.find((t) => t.task_id === "t_9ebcc66f").project_slug, "personal-tax-2025");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].boards, ["project-personal-tax-2025", "project-other"]);
}

// Requirement "An owner Gmail reply is handed off to the open tracks of its thread".
{
  // Scenario "A blocked owner question on the thread".
  const tasks = [taxTrack()];
  const fake = fakeBridge(tasks);
  const result = await handoffOwnerGmailReply(input, deps(fake.bridge));
  assert.deepEqual(result, { handedOff: ["t_9ebcc66f"] });
  assert.match(tasks[0].body, new RegExp(`mail_handoff:\\n  message_id: ${REPLY_ID}`));
  assert.match(tasks[0].body, /from: Owner Name <owner@example.com>/);
  assert.match(tasks[0].body, /The owner sent a reply on this thread from owner Gmail/);
  assert.equal(tasks[0].status, "ready");

  // Scenario "The same reply is seen twice".
  tasks[0].status = "blocked";
  const again = await handoffOwnerGmailReply(input, deps(fake.bridge));
  assert.deepEqual(again, { handedOff: [] });
  assert.equal(tasks[0].status, "blocked");
}

{
  // Scenario "No open track references the thread".
  const fake = fakeBridge([]);
  const result = await handoffOwnerGmailReply(input, deps(fake.bridge));
  assert.deepEqual(result, { handedOff: [], skipped: "no_open_track" });
  assert.deepEqual(fake.calls.map((c) => c.action), ["find_open_by_text"]);
}

{
  // Scenario "The companion is a recipient".
  const fake = fakeBridge([taxTrack()]);
  const result = await handoffOwnerGmailReply(
    { ...input, cc: [`Companion <${COMPANION.toUpperCase()}>`] },
    deps(fake.bridge),
  );
  assert.deepEqual(result, { handedOff: [], skipped: "companion_recipient" });
  assert.equal(fake.calls.length, 0);
}

// Scenario "Day 0", and a thread without a prior mail mirror.
{
  const gate = (o) => shouldHandoffOwnerGmailReply({ priorMirrorMessageIds: ["m1"], classifyTriage: true, skipTriageStubs: false, ...o });
  assert.equal(gate({}), true);
  assert.equal(gate({ skipTriageStubs: true }), false);
  assert.equal(gate({ classifyTriage: false }), false);
  assert.equal(gate({ priorMirrorMessageIds: null }), false);
  assert.equal(gate({ priorMirrorMessageIds: [] }), false);
}

console.log("gmail owner reply tests passed");
