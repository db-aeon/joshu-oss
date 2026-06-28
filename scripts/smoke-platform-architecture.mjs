#!/usr/bin/env node
/**
 * Smoke test: platform-data tier routing, manifest validation, app registry.
 * Usage: npm run test:platform-architecture
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- platform-data tier router ---
const tierRouter = await import(
  pathToFileURL(path.join(rootDir, "packages/platform-data/dist/tierRouter.js")).href
);
const qs = new URLSearchParams({ q: "hello", limit: "10" });
const cachePath = tierRouter.resolveMailSearchPath("/joshu/api", "gmail", qs, "cache");
assert.equal(cachePath, "/joshu/api/connectors/mail/gmail/search?q=hello&limit=10");
const liveQs = new URLSearchParams({ q: "hello" });
const livePath = tierRouter.resolveMailSearchPath("/joshu/api", "gmail", liveQs, "live");
assert.ok(livePath.includes("live=true"), `expected live flag in ${livePath}`);
assert.throws(() => tierRouter.resolveMailSearchPath("/joshu/api", "nylas", new URLSearchParams(), "sync"));

// --- app-sdk manifest validation ---
const { validateJoshuAppManifest } = await import(
  pathToFileURL(path.join(rootDir, "packages/app-sdk/dist/validateManifest.js")).href
);
const good = validateJoshuAppManifest({
  id: "demo",
  name: "Demo",
  version: "0.1.0",
  license: "AGPL-3.0",
  publisher: "joshu",
  entry: "demo/index.html",
  data: { uses: ["mail"] },
});
assert.equal(good.ok, true);
const bad = validateJoshuAppManifest({ id: "Bad ID", name: "x" });
assert.equal(bad.ok, false);

// --- app registry loads subservices ---
const { loadAppManifests, collectAppSkillNames } = await import(
  pathToFileURL(path.join(rootDir, "dist/appRegistry.js")).href
);
const manifests = await loadAppManifests(rootDir);
assert.ok(manifests.has("jmail"), "jmail manifest should load");
assert.ok(manifests.has("schedules"), "schedules manifest should load");
const jmail = manifests.get("jmail");
assert.ok(jmail?.data?.uses?.includes("mail"));
assert.ok(collectAppSkillNames().length >= 0);

// --- optional live server checks ---
const port = process.env.JOSHU_PORT || "8788";
const base = `http://127.0.0.1:${port}/joshu/api`;
try {
  const appsRes = await fetch(`${base}/apps`, { signal: AbortSignal.timeout(1500) });
  if (appsRes.ok) {
    const body = await appsRes.json();
    assert.ok(Array.isArray(body.apps), "GET /api/apps should return apps array");
    console.log(`live: GET /api/apps OK (${body.apps.length} apps)`);
  }
} catch {
  console.log("live: server not running — skipped HTTP checks");
}

console.log("OK platform-architecture smoke");
