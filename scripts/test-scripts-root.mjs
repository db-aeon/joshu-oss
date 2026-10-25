#!/usr/bin/env npx tsx
/**
 * Unit tests: bridge scripts resolve from the scripts root of the image
 * (change image-owned-box-runtime, requirement "Joshu API runs bridge scripts
 * from the scripts root of the image").
 *
 * Usage: npm run test:scripts-root
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hermesScriptPath, hermesScriptsDir } from "../src/hermesVoiceRuntime.js";
import { resolveScriptPath } from "../src/scriptsRoot.js";

const root = await mkdtemp(path.join(tmpdir(), "joshu-scripts-root-"));
const saved = process.env.JOSHU_SCRIPTS_ROOT;
try {
  await writeFile(path.join(root, "hermes-kanban-bridge.py"), "# image copy\n");

  // Scripts root set and the script is there: the scripts root wins.
  process.env.JOSHU_SCRIPTS_ROOT = root;
  assert.equal(hermesScriptPath("hermes-kanban-bridge.py"), path.join(root, "hermes-kanban-bridge.py"));
  assert.equal(resolveScriptPath("/fallback", "hermes-kanban-bridge.py"), path.join(root, "hermes-kanban-bridge.py"));

  // Scripts root set but the script is not there: fall back to scripts/ next to dist/.
  assert.equal(hermesScriptPath("hermes-cron-bridge.py"), path.join(hermesScriptsDir(), "hermes-cron-bridge.py"));

  // No scripts root (local development): scripts/ next to dist/.
  delete process.env.JOSHU_SCRIPTS_ROOT;
  assert.equal(hermesScriptPath("hermes-kanban-bridge.py"), path.join(hermesScriptsDir(), "hermes-kanban-bridge.py"));
  assert.equal(resolveScriptPath("/fallback", "x.sh"), path.join("/fallback", "x.sh"));

  // Blank value counts as not set.
  process.env.JOSHU_SCRIPTS_ROOT = "  ";
  assert.equal(resolveScriptPath("/fallback", "x.sh"), path.join("/fallback", "x.sh"));

  console.log("scripts-root: all tests passed");
} finally {
  if (saved === undefined) delete process.env.JOSHU_SCRIPTS_ROOT;
  else process.env.JOSHU_SCRIPTS_ROOT = saved;
  await rm(root, { recursive: true, force: true });
}
