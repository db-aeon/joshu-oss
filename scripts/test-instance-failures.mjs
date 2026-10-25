#!/usr/bin/env npx tsx
/**
 * Unit tests: background-work failure report (Kanban failed runs + Hermes cron errors).
 *
 * Usage: npm run test:instance-failures
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { scanCronFailures, scanKanbanFailures } from "../src/instanceFailures.js";

const now = Math.floor(Date.now() / 1000);
const boardsDir = await mkdtemp(path.join(tmpdir(), "joshu-failures-"));

try {
  // Owner-reply task that crashed twice and was auto-blocked (fleet box, 2026-10-03).
  await mkdir(path.join(boardsDir, "ea-owner-reply"));
  const db = new DatabaseSync(path.join(boardsDir, "ea-owner-reply", "kanban.db"));
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, outcome TEXT, ended_at INTEGER, error TEXT);
  `);
  db.prepare("INSERT INTO tasks VALUES (?, ?)").run("t_crash", "blocked");
  db.prepare("INSERT INTO tasks VALUES (?, ?)").run("t_ok", "done");
  db.prepare("INSERT INTO tasks VALUES (?, ?)").run("t_owner_wait", "blocked");
  db.prepare("INSERT INTO tasks VALUES (?, ?)").run("t_old", "blocked");
  const run = db.prepare("INSERT INTO task_runs (task_id, outcome, ended_at, error) VALUES (?, ?, ?, ?)");
  run.run("t_crash", "crashed", now - 120, "pid 1 exited with code 1");
  run.run("t_crash", "crashed", now - 60, "pid 2 exited with code 1");
  run.run("t_ok", "completed", now - 60, null);
  run.run("t_owner_wait", "blocked", now - 60, null); // deliberate block, not a failure
  run.run("t_old", "timed_out", now - 3 * 86400, "idle"); // outside the 24h window
  db.close();

  // Board directory without a kanban.db is skipped.
  await mkdir(path.join(boardsDir, "empty-board"));

  const kanban = await scanKanbanFailures({
    boardsDir,
    boards: ["ea-owner-reply", "empty-board", "missing-board"],
    sinceEpochSec: now - 86400,
  });
  assert.equal(kanban.length, 1);
  assert.deepEqual(
    { ...kanban[0], lastFailedAt: undefined },
    {
      board: "ea-owner-reply",
      taskId: "t_crash",
      taskStatus: "blocked",
      outcome: "crashed",
      failedRuns: 2,
      lastFailedAt: undefined,
      error: "pid 2 exited with code 1",
    },
  );
  assert.equal(kanban[0].lastFailedAt, new Date((now - 60) * 1000).toISOString());

  // Cron: drift-guard skip, dead delivery target, healthy job, disabled failing job.
  const cron = scanCronFailures({
    jobs: [
      {
        id: "a1",
        name: "EA morning",
        enabled: true,
        last_status: "error",
        last_run_at: "2026-10-02T09:00:00-07:00",
        next_run_at: "2026-10-09T09:00:00-07:00",
        last_error: "RuntimeError: Skipped to prevent unintended spend: global inference config drifted",
      },
      {
        id: "b2",
        name: "Reminder - write Joseph at Wescom",
        enabled: true,
        last_status: "ok",
        last_delivery_error: "live adapter send failed: API server uses HTTP request/response, not send()",
      },
      { id: "c3", name: "EA evening", enabled: true, last_status: "ok" },
      { id: "d4", name: "Paused job", enabled: false, last_status: "error", last_error: "boom" },
    ],
  });
  assert.deepEqual(
    cron.map((j) => [j.jobId, j.lastStatus, Boolean(j.error), Boolean(j.deliveryError)]),
    [
      ["a1", "error", true, false],
      ["b2", "ok", false, true],
    ],
  );
  // The digest shows the next run, so a weekly job that failed days ago reads as "next run Friday".
  assert.equal(cron[0].nextRunAt, "2026-10-09T09:00:00-07:00");
  assert.equal(cron[1].nextRunAt, null);

  // Undeliverable cron jobs (box joe 94aec4e63369 as made on 2026-09-11), a paused one,
  // a reminder job with deliver=local, and a failed one-time job that Hermes completed.
  const undeliverable = scanCronFailures({
    jobs: [
      {
        id: "94aec4e63369",
        name: "Reminder - write Joseph at Wescom",
        enabled: true,
        last_status: "ok",
        deliver: "origin",
        origin: { platform: "api_server", chat_id: "proactive:resolve:t_a3abceed" },
      },
      {
        id: "p1",
        name: "Paused api_server job",
        enabled: false,
        state: "paused",
        deliver: "origin",
        origin: { platform: "api_server", chat_id: "hermes-chat-1" },
      },
      {
        id: "l1",
        name: "Reminder - write Joseph at Wescom",
        enabled: true,
        last_status: "ok",
        deliver: "local",
        origin: { platform: "api_server", chat_id: "proactive:resolve:t_a3abceed" },
      },
      { id: "s1", name: "SMS target", enabled: true, last_status: "ok", deliver: "sms:+15551234567" },
      { id: "t1", name: "Telegram brief", enabled: true, last_status: "ok", deliver: "telegram", origin: { platform: "telegram" } },
      { id: "o1", name: "Owner reminder: x", enabled: false, state: "completed", last_status: "error", last_error: "Script exited with code 1" },
    ],
  });
  assert.deepEqual(
    undeliverable.map((j) => [j.jobId, j.lastStatus]),
    [
      ["94aec4e63369", "undeliverable"],
      ["s1", "undeliverable"],
      ["o1", "error"],
    ],
  );
  assert.match(undeliverable[0].error, /api_server/);

  // Legacy top-level array shape and garbage input.
  assert.equal(scanCronFailures([{ id: "x", enabled: true, last_status: "error" }]).length, 1);
  assert.deepEqual(scanCronFailures(null), []);

  console.log("instance failures: all assertions passed");
} finally {
  await rm(boardsDir, { recursive: true, force: true });
}
