#!/usr/bin/env npx tsx
/**
 * Unit tests: track list (spec mail-tracks; OpenSpec changes mail-track-thread-match
 * and mail-track-compact-list). A fake Kanban bridge replaces hermes-kanban-bridge.py.
 *
 * Usage: npm run test:mail-track-thread-match
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMailIngressTaskBody,
  compactMailTrack,
  findOpenMailTrackByThread,
  listMailTrackTasks,
} from "../src/ea/mailCron.js";

/** Track created from thread 1a0f8f5e92175a30; thread 1a0fe82dba9c37ea attached later in source_paths. */
const MATCH_TRACK = {
  task_id: "t_7782fdc9",
  status: "blocked",
  body: `kind: mail_track
project_slug: office-purchase-requests
state: waiting
message_id: 1a0f8f5e92175a30
provider: gmail
thread_id: 1a0f8f5e92175a30
source_path: connectors/mail/gmail/owner_at_example_com/threads/1a0f8f5e92175a30.md
mail_handoff:
  message_id: 1a0fd7e60f0f5966
  source_path: connectors/mail/gmail/owner_at_example_com/threads/1a0f8f5e92175a30.md
  at: 2026-10-02T16:44:23.481Z
  summary: "Everything together please"
source_paths:
  - connectors/mail/gmail/owner_at_example_com/threads/1a0fe82dba9c37ea.md
mail_handoff:
  message_id: 1a0fe82dba9c37ea
  source_path: connectors/mail/gmail/owner_at_example_com/threads/1a0fe82dba9c37ea.md
  at: 2026-10-02T21:35:53.830Z
  summary: "Card on file declined"
`,
};

/** Another track on the same project board, different thread. */
const ECHO_QUOTE_TRACK = {
  task_id: "t_8efe7137",
  status: "blocked",
  body: `kind: mail_track
project_slug: office-purchase-requests
state: waiting
message_id: 1a0f360cbafdf271
provider: gmail
thread_id: 1a0d0d1a5067e0f8
source_path: connectors/mail/gmail/owner_at_example_com/threads/1a0d0d1a5067e0f8.md
`,
};

const TRACKS = [ECHO_QUOTE_TRACK, MATCH_TRACK];

// Scenario: Thread is in the source paths of a track
assert.equal(findOpenMailTrackByThread(TRACKS, "1a0fe82dba9c37ea")?.task_id, "t_7782fdc9");

// Scenario: Track was created from the thread
assert.equal(findOpenMailTrackByThread(TRACKS, "1a0d0d1a5067e0f8")?.task_id, "t_8efe7137");
assert.equal(findOpenMailTrackByThread(TRACKS, "1a0f8f5e92175a30")?.task_id, "t_7782fdc9");

// Scenario: No open track matches the thread
assert.equal(findOpenMailTrackByThread(TRACKS, "1a0ffffffffffff0"), undefined);

// Empty or blank thread id never matches
assert.equal(findOpenMailTrackByThread(TRACKS, ""), undefined);
assert.equal(findOpenMailTrackByThread(TRACKS, "   "), undefined);

// Scenario: Body of an ingress task
const ingressBody = await buildMailIngressTaskBody(
  {
    filesRoot: "/tmp",
    provider: "gmail",
    threadId: "1a0fe82dba9c37ea",
    sourcePath: "connectors/mail/gmail/owner_at_example_com/threads/1a0fe82dba9c37ea.md",
    from: "Zachery Cooper <zach@example.com>",
    messageId: "1a0feafa20e78c71",
    classification: {
      category: "project_work",
      project_slug: "office-purchase-requests",
      is_new_track: false,
      reason: "test",
      scheduling_hint: false,
      authorization: {
        agent_authorized: false,
        scheduling_eligible: false,
        reason: "not_copied_or_delegated",
      },
    },
  },
  null,
);
const orderLine = ingressBody.split("\n").find((line) => line.startsWith("Order:")) ?? "";
assert.match(orderLine, /mail_list_track_tasks\(projectSlug=…, threadId=1a0fe82dba9c37ea\)/);
assert.match(orderLine, /one track returned → handoff to it/);
assert.match(orderLine, /done_match/);
assert.match(orderLine, /\(4b\) Project reconcile only if no handoff returned evaluation_queued: true/);

/** Fake Kanban bridge over a list of tasks. */
function fakeBridge(tasks) {
  return async (payload) => {
    switch (payload.action) {
      case "ensure_board":
        return { success: true };
      case "list":
        return {
          success: true,
          tasks: tasks
            .filter((t) => t.status === payload.status)
            .slice(0, payload.limit)
            .map((t) => ({ ...t })),
        };
      case "show": {
        const t = tasks.find((x) => x.task_id === payload.task_id);
        return t ? { success: true, task: { ...t } } : { success: false, error: "not found" };
      }
      default:
        throw new Error(`unexpected Kanban bridge action ${payload.action}`);
    }
  };
}

const filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mail-track-list-"));
const list = (opts, tasks) =>
  listMailTrackTasks({ filesRoot, projectSlug: "office-purchase-requests", ...opts }, fakeBridge(tasks));

// Requirement "Compact track list" — scenario "Track with two threads and two handoffs".
{
  const entry = compactMailTrack(MATCH_TRACK);
  assert.deepEqual(Object.keys(entry).sort(), ["latest_handoff", "status", "task_id", "thread_ids", "title"]);
  assert.deepEqual(entry.thread_ids, ["1a0f8f5e92175a30", "1a0fe82dba9c37ea"]);
  assert.equal(entry.latest_handoff.summary, "Card on file declined");
  assert.equal(entry.latest_handoff.at, "2026-10-02T21:35:53.830Z");
  assert.equal(compactMailTrack(ECHO_QUOTE_TRACK).latest_handoff, undefined);
  // A reopened track keeps completed_at in Hermes; its entry has no completed_at.
  assert.equal("completed_at" in compactMailTrack({ ...MATCH_TRACK, status: "ready", completed_at: 5 }), false);
}

// Long handoff summary is cut to 200 characters.
{
  const long = "x".repeat(500);
  const entry = compactMailTrack({
    task_id: "t_long",
    status: "blocked",
    body: `kind: mail_track\nthread_id: a1\nmail_handoff:\n  at: 2026-10-08T00:00:00Z\n  summary: ${JSON.stringify(long)}\n`,
  });
  assert.equal(entry.latest_handoff.summary.length, 200);
}

// Scenario "No threadId": compact track list, no full body.
{
  const out = await list({}, TRACKS);
  assert.equal(out.tasks.length, 2);
  for (const t of out.tasks) assert.equal("body" in t, false);
  assert.equal(out.done_match, undefined);
}

// Scenario "Busy project board": 40 open tracks with 136,120 characters of full bodies.
{
  const handoff = (i) =>
    `mail_handoff:\n  message_id: m${i}\n  source_path: connectors/mail/gmail/owner_at_example_com/threads/t${i}.md\n  at: 2026-10-08T00:00:00Z\n  summary: ${JSON.stringify("Vendor replied with an updated quote and asks for a decision on the sample run. ".repeat(3))}\n`;
  const busy = Array.from({ length: 40 }, (_, i) => {
    let body = `kind: mail_track\nproject_slug: nova-360\nstate: waiting\nthread_id: thr${i}\n`;
    while (body.length < 3403) body += handoff(i) + "Quoted mail history line. ".repeat(20) + "\n";
    return { task_id: `t_${i}`, title: `Track: Subject number ${i} about packaging`, status: "blocked", body };
  });
  const fullChars = busy.reduce((n, t) => n + t.body.length, 0);
  assert.ok(fullChars >= 136120);
  const out = await list({}, busy);
  assert.equal(out.tasks.length, 40);
  const response = JSON.stringify({ ok: true, count: out.tasks.length, tasks: out.tasks }, null, 2);
  assert.ok(response.length < 30000, `compact response has ${response.length} characters`);
}

// Requirement "Track list returns one full body by task id".
{
  const DONE = { ...ECHO_QUOTE_TRACK, task_id: "t_done1", status: "done", completed_at: 100 };
  let out = await list({ taskId: "t_7782fdc9" }, [...TRACKS, DONE]);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].body, MATCH_TRACK.body);
  out = await list({ taskId: "t_done1" }, [...TRACKS, DONE]);
  assert.equal(out.tasks[0].status, "done");
  assert.equal(out.tasks[0].body, DONE.body);
  out = await list({ taskId: "t_missing" }, TRACKS);
  assert.equal(out.tasks.length, 0);
}

// Requirement "Thread lookup reports the done match".
{
  const body = (tid) => `kind: mail_track\nthread_id: ${tid}\n`;
  const doneOld = { task_id: "t_old", status: "done", completed_at: 1000, body: body("thrT") };
  const doneNew = { task_id: "t_new", status: "done", completed_at: 2000, body: body("thrT") };
  // Scenario "Thread of a done track".
  let out = await list({ threadId: "thrT" }, [...TRACKS, doneNew, doneOld]);
  assert.equal(out.tasks.length, 0);
  assert.equal(out.done_match.task_id, "t_new");
  assert.equal(out.done_match.completed_at, 2000);
  assert.equal("body" in out.done_match, false);
  // Scenario "Open track and done track on the same thread".
  const open = { task_id: "t_open", status: "blocked", body: body("thrT") };
  out = await list({ threadId: "thrT" }, [open, doneNew]);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].task_id, "t_open");
  assert.equal(out.tasks[0].body, open.body);
  assert.equal(out.done_match, undefined);
  // No done track references the thread.
  out = await list({ threadId: "thrNone" }, [...TRACKS, doneNew]);
  assert.equal(out.tasks.length, 0);
  assert.equal(out.done_match, undefined);
}

console.log("mail-track-thread-match: ok");
