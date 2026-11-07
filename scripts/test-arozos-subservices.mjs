#!/usr/bin/env node
/**
 * Each Joshu ArozOS subservice that starts with `start.sh` has the marker `.startscript` and a
 * `moduleInfo.json`. Without `.startscript`, ArozOS looks for a binary, does not register the app,
 * and its desktop icon does nothing (the Research app on a box, 2026-10-30).
 *
 * Usage: npm run test:arozos-subservices
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "arozos", "subservice");
const apps = fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, "start.sh")));
assert.ok(apps.includes("research"), "the Research app is a subservice");
for (const app of apps) {
  assert.ok(fs.existsSync(path.join(dir, app, ".startscript")), `${app}: start.sh without .startscript, so ArozOS does not start it`);
  assert.ok(fs.existsSync(path.join(dir, app, "moduleInfo.json")), `${app}: no moduleInfo.json`);
}
console.log(`test:arozos-subservices — ${apps.length} subservices have .startscript and moduleInfo.json`);
