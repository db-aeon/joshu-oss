#!/usr/bin/env npx tsx
/**
 * Unit tests: eaKanbanCreateDefaults + bridge optional create kwargs contract.
 *
 * Usage: npm run test:kanban-bridge-max-runtime
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EA_KANBAN_BOARDS,
  EA_OWNER_REPLY_KANBAN_BOARD,
  eaKanbanCreateDefaults,
} from "../src/hermesKanbanBridge.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

{
  delete process.env.JOSHU_KANBAN_MAX_RUNTIME_EA;
  delete process.env.JOSHU_KANBAN_MAX_RUNTIME_PROJECT;
  const defaults = eaKanbanCreateDefaults(EA_OWNER_REPLY_KANBAN_BOARD);
  assert.equal(defaults.max_runtime_seconds, 28_800);
}

{
  process.env.JOSHU_KANBAN_MAX_RUNTIME_EA = "3600";
  assert.equal(eaKanbanCreateDefaults(EA_OWNER_REPLY_KANBAN_BOARD).max_runtime_seconds, 3600);
  delete process.env.JOSHU_KANBAN_MAX_RUNTIME_EA;
}

{
  process.env.JOSHU_KANBAN_MAX_RUNTIME_PROJECT = "7200";
  assert.equal(eaKanbanCreateDefaults("project-demo").max_runtime_seconds, 7200);
  assert.deepEqual(eaKanbanCreateDefaults("ea-scheduling"), { max_runtime_seconds: 28_800 });
  delete process.env.JOSHU_KANBAN_MAX_RUNTIME_PROJECT;
}

for (const board of EA_KANBAN_BOARDS) {
  assert.ok(
    eaKanbanCreateDefaults(board).max_runtime_seconds,
    `EA board ${board} should get default runtime cap`,
  );
}

{
  const bridgePath = path.join(__dirname, "hermes-kanban-bridge.py");
  const source = readFileSync(bridgePath, "utf8");
  assert.match(source, /max_runtime_seconds/);
}

// Kanban bridge carries the block kind (change proactive-clarify-hardening, task 1.1).
{
  const source = readFileSync(path.join(__dirname, "hermes-kanban-bridge.py"), "utf8");
  assert.match(source, /"block_kind": getattr\(task, "block_kind", None\)/, "_task_summary returns block_kind");
  const blockAction = source.slice(source.indexOf('if action == "block":'), source.indexOf('if action == "list":'));
  assert.match(blockAction, /_payload_block_kind\(kanban_db, payload\)/, "action block reads kind");
  assert.match(blockAction, /\{"kind": kind\} if kind/, "action block passes kind to block_task");
  const updateAction = source.slice(source.indexOf('if action == "update_block_reason":'), source.indexOf('if action == "append_body":'));
  assert.match(updateAction, /set_kind = "kind" in payload/, "update_block_reason changes kind only when the payload has key kind");
  assert.match(updateAction, /UPDATE tasks SET block_kind = \? WHERE id = \?/, "update_block_reason writes block_kind");
  assert.match(updateAction, /\{"reason": reason, "kind": event_kind\}/, "update_block_reason events always have key kind");
  const clearAction = source.slice(source.indexOf('if action == "clear_stale_block_kinds":'), source.indexOf('if action == "append_body":'));
  assert.match(clearAction, /if "kind" in newest:\s*\n\s*continue/, "clear_stale_block_kinds keeps a block kind that the newest blocked event confirms");
  assert.match(clearAction, /UPDATE tasks SET block_kind = NULL/, "clear_stale_block_kinds clears a stale block kind");
}

console.log("test-kanban-bridge-max-runtime: ok");
