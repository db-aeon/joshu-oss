#!/usr/bin/env npx tsx
/**
 * Kanban bridge actions for the setup board (change owner-setup-board):
 * `set_body` (only on board ea-onboarding), `find_by_idempotency` with `include_body`,
 * and a setup tip card that is blocked without a block kind.
 *
 * The run tests need a local Hermes checkout (HERMES_AGENT_ROOT, default ~/.hermes/hermes-agent)
 * with its Python. Without Hermes, only the source checks run.
 *
 * Usage: npm run test:kanban-bridge-onboarding
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(__dirname, "hermes-kanban-bridge.py");

// Source checks.
{
  const source = readFileSync(bridgePath, "utf8");
  const setBody = source.slice(source.indexOf('if action == "set_body":'), source.indexOf('if action == "complete":'));
  assert.match(setBody, /board != "ea-onboarding"/, "set_body refuses other boards");
  const find = source.slice(source.indexOf('if action == "find_by_idempotency":'), source.indexOf('if action == "create":'));
  assert.match(find, /include_body=bool\(payload\.get\("include_body"\)\)/, "find_by_idempotency reads include_body");
}

const hermesRoot = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), ".hermes", "hermes-agent");
const python = [path.join(hermesRoot, "venv", "bin", "python"), path.join(hermesRoot, ".venv", "bin", "python")].find(
  (candidate) => existsSync(candidate),
);

if (!python) {
  console.log("test:kanban-bridge-onboarding — source checks passed; no Hermes checkout, run tests skipped");
  process.exit(0);
}

const home = mkdtempSync(path.join(os.tmpdir(), "joshu-kanban-onboarding-"));
function bridge(payload) {
  const run = spawnSync(python, [bridgePath], {
    input: JSON.stringify(payload),
    env: { ...process.env, HERMES_AGENT_ROOT: hermesRoot, HERMES_KANBAN_HOME: home, HERMES_HOME: home },
    encoding: "utf8",
  });
  const line = run.stdout.trim().split("\n").pop() ?? "";
  assert.ok(line, `bridge printed nothing: ${run.stderr}`);
  return JSON.parse(line);
}

try {
  for (const board of ["ea-onboarding", "ea-scheduling"]) {
    assert.equal(bridge({ action: "ensure_board", board }).success, true);
  }
  const create = (board, key) =>
    bridge({
      action: "create",
      board,
      title: "Setup card",
      body: "kind: onboarding\nprompt_id: tip-voice-pin\nhowto_version: old",
      assignee: "default",
      idempotency_key: key,
      workspace_kind: "dir",
      workspace_path: home,
    });

  const created = create("ea-onboarding", "onboarding:tip-voice-pin");
  assert.equal(created.success, true);
  const taskId = created.task_id;

  // A setup tip card is blocked without a block kind, so it is not an owner question.
  const blocked = bridge({ action: "block", board: "ea-onboarding", task_id: taskId, reason: "optional setup tip" });
  assert.equal(blocked.success, true);
  const found = bridge({
    action: "find_by_idempotency",
    board: "ea-onboarding",
    idempotency_key: "onboarding:tip-voice-pin",
    include_body: true,
  });
  assert.equal(found.task.status, "blocked");
  assert.ok(!found.task.block_kind, "setup tip card has no block kind");
  assert.match(found.task.body, /howto_version: old/);

  // Without include_body, the summary has no body.
  const short = bridge({
    action: "find_by_idempotency",
    board: "ea-onboarding",
    idempotency_key: "onboarding:tip-voice-pin",
  });
  assert.equal(short.task.body, undefined);

  // set_body replaces the body and keeps the status.
  const replaced = bridge({
    action: "set_body",
    board: "ea-onboarding",
    task_id: taskId,
    body: "kind: onboarding\nprompt_id: tip-voice-pin\nhowto_version: new",
  });
  assert.equal(replaced.success, true);
  assert.match(replaced.task.body, /howto_version: new/);
  assert.doesNotMatch(replaced.task.body, /howto_version: old/);
  assert.equal(replaced.task.status, "blocked");

  // set_body is refused on every other board.
  const other = create("ea-scheduling", "scheduling:test");
  const refused = bridge({ action: "set_body", board: "ea-scheduling", task_id: other.task_id, body: "x" });
  assert.equal(refused.success, false);
  assert.match(refused.error, /only on board ea-onboarding/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("test:kanban-bridge-onboarding — all passed");
