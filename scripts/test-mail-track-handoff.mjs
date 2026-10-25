#!/usr/bin/env npx tsx
/**
 * Unit tests: handoff to a track (spec mail-tracks; OpenSpec changes proactive-clarify-hardening
 * and mail-track-compact-list).
 * A fake Kanban bridge replaces hermes-kanban-bridge.py.
 *
 * Usage: npm run test:mail-track-handoff
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handoffMailToTrackTask } from "../src/ea/mailCron.js";
import { markMailDedupProcessed } from "../src/ea/mailDedup.js";

const TASK_ID = "t_0c0ffee1";
const MESSAGE_ID = "eb6a9b0e-e219-4054-80a5-a111730c7b70";
const SOURCE_PATH = "connectors/mail/nylas/threads/0e70095a-b510-4d33-bf67-5a1230ad3c44.md";

/** Fake Kanban bridge with one track. Records each action. */
function fakeBridge(status) {
  const task = { task_id: TASK_ID, title: "Riley Contact", status, body: "kind: mail_track\nstate: waiting" };
  const actions = [];
  const bridge = async (payload) => {
    actions.push(payload.action);
    switch (payload.action) {
      case "show":
        return { success: true, task: { ...task } };
      case "append_body":
        task.body += `\n${payload.append}`;
        return { success: true };
      case "comment":
        return { success: true };
      case "unblock":
        task.status = "ready";
        return { success: true, action_taken: "unblocked" };
      case "reopen":
        task.status = "ready";
        return { success: true, action_taken: "reopened" };
      default:
        throw new Error(`unexpected Kanban bridge action ${payload.action}`);
    }
  };
  return { bridge, task, actions };
}

function tempFilesRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mail-track-handoff-"));
}

function handoff(filesRoot, bridge, summary = "Riley Contact replied: I'd love a referral link.") {
  return handoffMailToTrackTask(
    {
      filesRoot,
      projectSlug: "acme-partnerships",
      taskId: TASK_ID,
      sourcePath: SOURCE_PATH,
      messageId: MESSAGE_ID,
      summary,
    },
    bridge,
  );
}

// Requirement "Handoff to a blocked track wakes the worker" — scenario "Email on a blocked track".
{
  const fake = fakeBridge("blocked");
  const result = await handoff(tempFilesRoot(), fake.bridge);
  assert.equal(result.ok, true);
  assert.equal(result.evaluation_queued, true);
  assert.match(fake.task.body, /mail_handoff:\n  message_id: eb6a9b0e-e219-4054-80a5-a111730c7b70/);
  assert.equal(fake.task.status, "ready");
}

// Scenario "Companion is not agent authorized for the email".
{
  const filesRoot = tempFilesRoot();
  await markMailDedupProcessed({
    filesRoot,
    dedupKey: "gmail:test",
    provider: "gmail",
    threadId: "0e70095a",
    messageId: MESSAGE_ID,
    authorization: { agent_authorized: false, scheduling_eligible: false, reason: "file_only_not_copied" },
  });
  const fake = fakeBridge("blocked");
  const result = await handoff(filesRoot, fake.bridge);
  assert.equal(result.ok, true);
  assert.equal(fake.task.status, "ready");
}

// Scenario "Email on a track that is not blocked".
{
  const fake = fakeBridge("running");
  const result = await handoff(tempFilesRoot(), fake.bridge);
  assert.equal(result.ok, true);
  assert.equal(result.evaluation_queued, false);
  assert.equal(fake.task.status, "running");
  assert.ok(!fake.actions.includes("unblock"));
}

// Requirement "Handoff to a done track reopens the track" — scenario "Email on a done track".
{
  const fake = fakeBridge("done");
  const result = await handoff(tempFilesRoot(), fake.bridge);
  assert.equal(result.ok, true);
  assert.equal(result.evaluation_queued, true);
  assert.match(fake.task.body, /mail_handoff:\n  message_id: eb6a9b0e-e219-4054-80a5-a111730c7b70/);
  assert.equal(fake.task.status, "ready");
  assert.deepEqual(fake.actions, ["show", "append_body", "comment", "reopen"]);
}

// Requirement "Handoff does not judge the email" — scenario "Handoff summary contains "confirmed"".
{
  const fake = fakeBridge("blocked");
  await handoff(tempFilesRoot(), fake.bridge, "Jordan: you're confirmed for Tuesday.");
  assert.deepEqual(fake.actions, ["show", "append_body", "comment", "unblock"]);
  assert.equal(fake.task.status, "ready");
}

// Scenario "Mail mirror contains "confirms"": no question for the owner is queued.
{
  const filesRoot = tempFilesRoot();
  const mirror = path.join(filesRoot, SOURCE_PATH);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.writeFileSync(mirror, "Jordan confirms she sent the NDA through Adobe Sign.\n");
  const cwd = process.cwd();
  const projectRoot = tempFilesRoot();
  process.chdir(projectRoot);
  try {
    const fake = fakeBridge("blocked");
    await handoff(filesRoot, fake.bridge, "Jordan confirms she sent the NDA.");
    assert.deepEqual(fake.actions, ["show", "append_body", "comment", "unblock"]);
    assert.ok(!fs.existsSync(path.join(projectRoot, ".joshu", "proactive", "state.json")));
  } finally {
    process.chdir(cwd);
  }
}

console.log("test-mail-track-handoff: ok");
