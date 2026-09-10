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

console.log("test-kanban-bridge-max-runtime: ok");
