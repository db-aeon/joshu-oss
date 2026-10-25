#!/usr/bin/env node
/**
 * Which Desktop file events schedule a File Brain reindex (gbrain MCP bridge watcher).
 */
import assert from "node:assert/strict";
import { shouldWatchFsEvent, shouldWatchPath } from "./lib/gbrain-mcp-bridge.mjs";

// Markdown edits and folder renames (ArozOS trash, moves) reindex.
assert.equal(shouldWatchFsEvent("change", "joshu's files/Projects/demo/about.md"), true);
assert.equal(shouldWatchFsEvent("change", "notes/plan.MDX"), true);
assert.equal(shouldWatchFsEvent("rename", "Appliances"), true);
assert.equal(shouldWatchFsEvent("rename", ""), true);
assert.equal(shouldWatchFsEvent("change", "joshu's files/connectors/_state/nylas-sync.json"), false);

// Git internals and ArozOS metadata never reindex.
assert.equal(shouldWatchFsEvent("rename", ".git/index.lock"), false);
assert.equal(shouldWatchFsEvent("rename", ".metadata/.trash/Appliances"), false);

// Joshu's own state under .joshu/ never reindexes: the realtime goals broker
// rewrites state.json every few seconds (2026-10-24).
assert.equal(
  shouldWatchFsEvent("rename", "joshu's files/.joshu/realtime-goals/state.json.1442.1792807141204.tmp"),
  false,
);
assert.equal(shouldWatchFsEvent("rename", "joshu's files/.joshu/realtime-goals/state.json"), false);
assert.equal(shouldWatchFsEvent("rename", "joshu's files/.joshu"), false);
assert.equal(shouldWatchFsEvent("change", "joshu's files\\.joshu\\notes.md"), false);
assert.equal(shouldWatchPath("joshu's files/.joshu/notes.md"), false);

// The temporary half of an atomic write never reindexes; the rename onto the real file does.
assert.equal(shouldWatchFsEvent("rename", "joshu's files/Triage/.stub.md.ab12cd34.tmp"), false);
assert.equal(shouldWatchFsEvent("rename", "joshu's files/Triage/stub.md"), true);

// A folder whose name only contains ".joshu" is still watched.
assert.equal(shouldWatchFsEvent("rename", "joshu's files/my.joshu-notes"), true);

assert.equal(shouldWatchPath("Welcome.shortcut"), false);

console.log("gbrain watch filter checks passed");
