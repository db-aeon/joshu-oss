#!/usr/bin/env npx tsx
/**
 * Unit tests: orphan reaper cmdline parsing self-test.
 *
 * Usage: npm run test:kanban-orphan-reaper
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "hermes-kanban-orphan-reaper.py");

const result = spawnSync("python3", [script, "--self-test"], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /"self_test": "passed"/);

console.log("test-kanban-orphan-reaper: ok");
