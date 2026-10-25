#!/usr/bin/env npx tsx
/**
 * Kanban bridge action `list_blocked` (spec team-standup, the blockers of a team stand-up):
 * blocked tasks of all boards in one call, with the latest block reason, without the team
 * boards of other teams.
 *
 * The run tests need a local Hermes checkout (HERMES_AGENT_ROOT, default ~/.hermes/hermes-agent)
 * with its Python. Without Hermes, only the source checks run.
 *
 * Usage: npm run test:kanban-bridge-list-blocked
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
  const action = source.slice(source.indexOf('if action == "list_blocked":'), source.indexOf("conn = kanban_db.connect(board=board)"));
  assert.match(action, /list_boards\(include_archived=False\)/, "list_blocked reads every board that is not archived");
  assert.match(action, /slug\.startswith\(exclude_prefix\) and slug not in include/, "list_blocked skips excluded boards");
  assert.ok(
    source.indexOf('if action == "list_blocked":') < source.indexOf("conn = kanban_db.connect(board=board)"),
    "list_blocked runs before the bridge opens the one board of the payload",
  );
}

const hermesRoot = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), ".hermes", "hermes-agent");
const python = [path.join(hermesRoot, "venv", "bin", "python"), path.join(hermesRoot, ".venv", "bin", "python")].find(
  (candidate) => existsSync(candidate),
);

if (!python) {
  console.log("test:kanban-bridge-list-blocked — source checks passed; no Hermes checkout, run tests skipped");
  process.exit(0);
}

const home = mkdtempSync(path.join(os.tmpdir(), "joshu-kanban-list-blocked-"));
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

function blockedTask(board, title, reason) {
  const created = bridge({
    action: "create",
    board,
    title,
    body: "x",
    assignee: "default",
    workspace_kind: "dir",
    workspace_path: home,
  });
  assert.equal(created.success, true, created.error);
  assert.equal(bridge({ action: "block", board, task_id: created.task_id, reason }).success, true);
  return created.task_id;
}

try {
  for (const board of ["project-harbor", "team-acme", "team-family"]) {
    assert.equal(bridge({ action: "ensure_board", board }).success, true);
  }
  const harbor = blockedTask("project-harbor", "Answer Harbor about pricing", "awaiting the Q4 price list from Sam");
  const acme = blockedTask("team-acme", "Send the brief", "waiting on Maya's OK");
  blockedTask("team-family", "School pickup Thursday", "Dan has to say yes");
  // A task that is not blocked is not listed.
  const open = bridge({
    action: "create",
    board: "project-harbor",
    title: "Draft the invoice",
    body: "x",
    assignee: "default",
    workspace_kind: "dir",
    workspace_path: home,
  });
  assert.equal(open.success, true);

  const out = bridge({ action: "list_blocked", exclude_prefix: "team-", include_boards: ["team-acme"] });
  assert.equal(out.success, true, out.error);
  assert.equal(out.truncated, false);
  const byId = new Map(out.tasks.map((t) => [t.task_id, t]));
  assert.equal(byId.get(harbor)?.board, "project-harbor");
  assert.equal(byId.get(harbor)?.block_reason, "awaiting the Q4 price list from Sam");
  assert.equal(byId.get(acme)?.board, "team-acme", "the team board of this team is listed");
  assert.ok(!out.tasks.some((t) => t.board === "team-family"), "the team board of another team is not listed");
  assert.ok(!byId.has(open.task_id), "a task that is not blocked is not listed");

  const limited = bridge({ action: "list_blocked", exclude_prefix: "team-", limit: 1 });
  assert.equal(limited.tasks.length, 1);
  assert.equal(limited.truncated, true);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("test:kanban-bridge-list-blocked — all passed");
