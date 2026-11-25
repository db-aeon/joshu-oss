#!/usr/bin/env npx tsx
/**
 * Unit tests: Joshu sets the size limits of Hermes memory (MEMORY.md and USER.md) in the Hermes
 * config, keeps a higher limit, and reports a change only when it changed a limit
 * (spec hermes-memory, change hermes-memory-room).
 *
 * Usage: npm run test:hermes-memory-limits
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JOSHU_HERMES_MEMORY_CHAR_LIMIT,
  JOSHU_HERMES_USER_CHAR_LIMIT,
  syncJoshuHermesMemoryLimits,
} from "../src/hermesMemoryLimits.js";

test("the limits are 6,000 and 4,000 characters", () => {
  assert.equal(JOSHU_HERMES_MEMORY_CHAR_LIMIT, 6000);
  assert.equal(JOSHU_HERMES_USER_CHAR_LIMIT, 4000);
});

test("a config without size limits gets both limits and keeps the other memory keys", () => {
  const config = { memory: { provider: "hindsight" }, model: { default: "some-model" } };
  assert.equal(syncJoshuHermesMemoryLimits(config), true);
  assert.deepEqual(config.memory, { provider: "hindsight", memory_char_limit: 6000, user_char_limit: 4000 });
  assert.deepEqual(config.model, { default: "some-model" });
});

test("a config without a memory block gets one", () => {
  const config = {};
  assert.equal(syncJoshuHermesMemoryLimits(config), true);
  assert.deepEqual(config.memory, { memory_char_limit: 6000, user_char_limit: 4000 });
});

test("a lower limit is raised", () => {
  const config = { memory: { memory_char_limit: 2200, user_char_limit: "1375" } };
  assert.equal(syncJoshuHermesMemoryLimits(config), true);
  assert.deepEqual(config.memory, { memory_char_limit: 6000, user_char_limit: 4000 });
});

test("a higher limit stays", () => {
  const config = { memory: { memory_char_limit: 2200, user_char_limit: 8000 } };
  assert.equal(syncJoshuHermesMemoryLimits(config), true);
  assert.deepEqual(config.memory, { memory_char_limit: 6000, user_char_limit: 8000 });
});

test("a second call reports no change", () => {
  const config = { memory: { provider: "hindsight" } };
  syncJoshuHermesMemoryLimits(config);
  const before = JSON.stringify(config);
  assert.equal(syncJoshuHermesMemoryLimits(config), false);
  assert.equal(JSON.stringify(config), before);
});

test("a limit that is not a number is replaced", () => {
  const config = { memory: { memory_char_limit: "many", user_char_limit: null } };
  assert.equal(syncJoshuHermesMemoryLimits(config), true);
  assert.deepEqual(config.memory, { memory_char_limit: 6000, user_char_limit: 4000 });
});
