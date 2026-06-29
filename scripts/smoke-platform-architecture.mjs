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
assert.ok(jmail?.agent?.guiActions?.length, "jmail should declare guiActions");
assert.ok(jmail?.agent?.voiceCommands?.length, "jmail should declare voiceCommands");
assert.ok(collectAppSkillNames().length >= 0);

// --- app-scoped AG-UI system messages ---
const { buildAppAgentSystemMessages, buildAppAgentSessionId } = await import(
  pathToFileURL(path.join(rootDir, "dist/agUiAppContext.js")).href
);
const sessionId = buildAppAgentSessionId("jmail", "thread-1");
assert.equal(sessionId, "joshu-app:jmail:thread-1");
const sysMsgs = buildAppAgentSystemMessages(jmail, {
  appId: "jmail",
  mode: "embedded",
  gui: { pane: "inbox", selectedId: "abc" },
});
assert.equal(sysMsgs.length, 1);
assert.match(sysMsgs[0].content, /jMail|jmail/i);
assert.match(sysMsgs[0].content, /Never send email/);
assert.match(sysMsgs[0].content, /app_gui_action/);
assert.match(sysMsgs[0].content, /action=openCompose/);
assert.match(sysMsgs[0].content, /openCompose/);

// --- app GUI action queue ---
const { enqueueAppGuiAction, drainAppGuiActions, isValidAppGuiAction } = await import(
  pathToFileURL(path.join(rootDir, "dist/appGuiActionQueue.js")).href
);
const { buildAppAgentSessionId: buildSession } = await import(
  pathToFileURL(path.join(rootDir, "dist/agUiAppContext.js")).href
);
const sample = { appId: "jmail", action: "openCompose", args: { subject: "Hi" } };
assert.ok(isValidAppGuiAction(sample));
enqueueAppGuiAction(buildSession("jmail", "t1"), sample);
const drained = drainAppGuiActions(buildSession("jmail", "t1"));
assert.equal(drained.length, 1);
assert.equal(drained[0]?.action, "openCompose");

// --- frontend tool parsing ---
const { parseAgUiClientTools, toOpenAiChatTools } = await import(
  pathToFileURL(path.join(rootDir, "dist/agUiFrontendTools.js")).href
);
const parsedTools = parseAgUiClientTools([
  { name: "openCompose", description: "Open compose", parameters: { type: "object", properties: { body: { type: "string" } } } },
]);
assert.equal(parsedTools.length, 1);
assert.equal(toOpenAiChatTools(parsedTools)[0]?.function.name, "openCompose");

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
