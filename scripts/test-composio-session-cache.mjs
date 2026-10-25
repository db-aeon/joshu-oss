#!/usr/bin/env npx tsx
/**
 * Unit test: the Composio tool-router session of a box. Parallel tool calls share one session
 * request, a tool call does not update the session, the session gets the auth configs only
 * when they change, and only a "session not found" error makes a new session (a 409 or a 429
 * does not). A box made about 7,400 sessions in 20 hours on 2026-10-20 without these rules.
 * Each box also has a read session (read-only tools, workbench on) that follows the same rules.
 *
 * Usage: npm run test:composio-session-cache
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "composio-session-"));
process.env.COMPOSIO_API_KEY = "test-key";
process.env.COMPOSIO_USER_ID = "test-user";
process.env.JOSHU_AROZ_USER = "test-user";
process.env.AROZ_DATA = path.join(root, "aroz");
process.env.HERMES_HOME = path.join(root, "hermes");
delete process.env.JOSHU_COMPOSIO_AUTH_CONFIGS;
delete process.env.JOSHU_COMPOSIO_ONENOTE_AUTH_CONFIG_ID;
delete process.env.JOSHU_COMPOSIO_SLACKBOT_AUTH_CONFIG_ID;
delete process.env.JOSHU_ACTION_GUARD_ENABLED;

const { setComposioClientForTest } = await import("../src/connectors/composio/client.ts");
const { getOrCreateComposioSession, resetComposioSessionCache } = await import("../src/composioApi.ts");
const { composioToolsExecute } = await import("../src/composio/executeWithModifiers.ts");

const projectRoot = root;
const joshuDir = path.join(root, "aroz", "files", "users", "test-user", ".joshu");
const storeFile = path.join(joshuDir, "composio-session.json");
const authConfigsFile = path.join(joshuDir, "composio-auth-configs.json");

function httpError(status, body) {
  const err = new Error(`${status} ${JSON.stringify({ error: body })}`);
  err.status = status;
  return err;
}

/** Stub of the Composio SDK. `behavior` sets what use() and update() do. */
function stubComposio(behavior = {}) {
  const calls = { create: 0, use: 0, update: 0, execute: 0, updates: [], creates: [], updatedSessions: [] };
  let next = 0;
  const sessionFor = (sessionId) => ({
    sessionId,
    mcp: { type: "http", url: `https://composio.test/tool_router/${sessionId}/mcp`, headers: { "x-api-key": "k" } },
    update: async (config) => {
      calls.update += 1;
      calls.updates.push(config);
      calls.updatedSessions.push(sessionId);
      await new Promise((r) => setTimeout(r, 5));
      if (behavior.updateError) {
        const err = behavior.updateError(calls.update);
        if (err) throw err;
      }
      return {};
    },
  });
  const client = {
    create: async (_userId, config) => {
      calls.create += 1;
      calls.creates.push(config);
      await new Promise((r) => setTimeout(r, 5));
      next += 1;
      return sessionFor(`trs_new${next}`);
    },
    use: async (sessionId) => {
      calls.use += 1;
      await new Promise((r) => setTimeout(r, 5));
      if (behavior.useError) throw behavior.useError;
      return sessionFor(sessionId);
    },
    tools: {
      execute: async () => {
        calls.execute += 1;
        return { successful: true, data: {} };
      },
    },
  };
  setComposioClientForTest(client);
  return calls;
}

function readStoreFile() {
  return JSON.parse(readFileSync(storeFile, "utf8"));
}

function writeStoreFile(store) {
  mkdirSync(joshuDir, { recursive: true });
  writeFileSync(storeFile, JSON.stringify(store));
}

function fresh() {
  resetComposioSessionCache();
}

const isReadConfig = (config) => Array.isArray(config?.tags) && config.tags.includes("readOnlyHint");

// 1. No store: 40 parallel tool calls make one main session, one read session, and no update.
{
  fresh();
  mkdirSync(joshuDir, { recursive: true });
  writeFileSync(authConfigsFile, JSON.stringify({ slackbot: "ac_slackbot" }));
  const calls = stubComposio();
  const args = { userId: "test-user", connectedAccountId: "ca_1", arguments: {} };
  await Promise.all(
    Array.from({ length: 40 }, () => composioToolsExecute("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", args, projectRoot)),
  );
  assert.equal(calls.execute, 40, "each tool call runs");
  assert.equal(calls.create, 2, "one main session and one read session for parallel tool calls");
  assert.deepEqual(calls.creates.map(isReadConfig), [false, true]);
  assert.equal(calls.creates[0].workbench.enable, false, "the main session has the workbench off");
  assert.equal(calls.creates[1].workbench.enable, true, "the read session has the workbench on");
  assert.equal(calls.update, 0, "create sends the auth configs, no update per tool call");
  assert.equal(calls.use, 0);
  assert.equal(readStoreFile().sessionId, "trs_new1");
  assert.equal(readStoreFile().workbenchOff, true, "a new session starts with the workbench off");
  assert.equal(readStoreFile().readSession.sessionId, "trs_new2");
  assert.equal(readStoreFile().readSession.authConfigsKey, readStoreFile().authConfigsKey);
  assert.deepEqual(
    readdirSync(joshuDir).filter((f) => f.endsWith(".tmp")),
    [],
    "the store write leaves no temp file",
  );

  // Later tool calls in the same process use the cached session.
  await composioToolsExecute("GMAIL_FETCH_EMAILS", args, projectRoot);
  assert.equal(calls.create + calls.use + calls.update, 2, "no session call on a later tool call");
}

// 2. A stored session from an older release (no auth configs key, no read session): one use, one
//    update, and one new read session for parallel callers; a restart after that does not update again.
{
  fresh();
  writeStoreFile({ userId: "test-user", sessionId: "trs_old", updatedAt: "2026-10-20T00:00:00Z" });
  let calls = stubComposio();
  const results = await Promise.all(Array.from({ length: 20 }, () => getOrCreateComposioSession(projectRoot)));
  assert.ok(results.every((r) => r.sessionId === "trs_old"), "parallel callers get the stored session");
  assert.equal(calls.use, 1, "one session request for parallel callers");
  assert.equal(calls.update, 1, "auth configs sent once");
  assert.deepEqual(calls.updates[0].workbench, { enable: false }, "the same update turns the workbench off");
  assert.equal(readStoreFile().workbenchOff, true);
  assert.equal(calls.create, 1, "the read session is made once");
  assert.ok(isReadConfig(calls.creates[0]));
  const readSessionId = readStoreFile().readSession.sessionId;

  fresh(); // a process restart
  calls = stubComposio();
  await getOrCreateComposioSession(projectRoot);
  assert.equal(calls.update, 0, "same auth configs after a restart: no update");
  assert.equal(calls.create, 0, "the read session is reused after a restart");
  assert.equal(readStoreFile().readSession.sessionId, readSessionId);

  // A changed auth config is sent once to each session.
  writeFileSync(authConfigsFile, JSON.stringify({ slackbot: "ac_slackbot", onenote: "ac_onenote" }));
  await Promise.all(Array.from({ length: 10 }, () => getOrCreateComposioSession(projectRoot)));
  assert.deepEqual(calls.updatedSessions.sort(), ["trs_old", readSessionId].sort(), "changed auth configs: one update for each session");
  assert.equal(calls.create, 0);
}

// 2b. A stored session with current auth configs but the workbench on: one update for the workbench only.
{
  fresh();
  const stored = readStoreFile();
  writeStoreFile({ ...stored, workbenchOff: undefined });
  const calls = stubComposio();
  await getOrCreateComposioSession(projectRoot);
  assert.deepEqual(calls.updates, [{ workbench: { enable: false } }]);
  assert.equal(readStoreFile().workbenchOff, true);
}

// 2c. A failed read session leaves the main session working; the next refresh tries again.
{
  fresh();
  const { readSession: _readSession, ...stored } = readStoreFile();
  writeStoreFile(stored);
  setComposioClientForTest({
    use: async (sessionId) => ({ sessionId, mcp: { url: `https://composio.test/tool_router/${sessionId}/mcp`, headers: {} }, update: async () => ({}) }),
    create: async () => {
      throw httpError(500, { slug: "HTTP_InternalServerError", status: 500 });
    },
  });
  const result = await getOrCreateComposioSession(projectRoot);
  assert.equal(result.sessionId, "trs_old", "the main session still works");
  assert.equal(readStoreFile().readSession, undefined);

  fresh();
  const calls = stubComposio();
  await getOrCreateComposioSession(projectRoot);
  assert.equal(calls.create, 1, "the next refresh makes the read session");
  assert.ok(readStoreFile().readSession.sessionId);
}

// 3. A 409 on update re-fetches the session and retries; it never makes a new session.
{
  fresh();
  writeStoreFile({ userId: "test-user", sessionId: "trs_conflict", updatedAt: "2026-10-20T00:00:00Z" });
  const conflict = httpError(409, { slug: "ToolRouterV2_ConfigVersionConflict", status: 409 });
  let calls = stubComposio({ updateError: (n) => (n === 1 ? conflict : null) });
  const result = await getOrCreateComposioSession(projectRoot);
  assert.equal(result.sessionId, "trs_conflict");
  assert.equal(calls.creates.filter((c) => !isReadConfig(c)).length, 0, "409 does not make a new session");
  assert.equal(calls.update, 2, "409: one retry after a re-fetch");

  fresh();
  writeStoreFile({ userId: "test-user", sessionId: "trs_conflict", updatedAt: "2026-10-20T00:00:00Z" });
  calls = stubComposio({ updateError: () => conflict });
  assert.equal((await getOrCreateComposioSession(projectRoot)).sessionId, "trs_conflict");
  assert.equal(calls.creates.filter((c) => !isReadConfig(c)).length, 0, "409 twice still keeps the session");
}

// 4. A 429 from Composio fails the call; it never makes a new session.
{
  fresh();
  writeStoreFile({ userId: "test-user", sessionId: "trs_limited", updatedAt: "2026-10-20T00:00:00Z" });
  const calls = stubComposio({ useError: httpError(429, { slug: "HTTP_TooManyRequests", status: 429 }) });
  await assert.rejects(() => getOrCreateComposioSession(projectRoot), /429/);
  assert.equal(calls.creates.filter((c) => !isReadConfig(c)).length, 0, "429 does not make a new session");
  assert.equal(readStoreFile().sessionId, "trs_limited", "the store keeps the session");
}

// 5. Only "session not found" makes a new session.
{
  fresh();
  writeStoreFile({ userId: "test-user", sessionId: "trs_gone", updatedAt: "2026-10-20T00:00:00Z" });
  const calls = stubComposio({ useError: httpError(404, { slug: "ToolRouterV2_SessionNotFound", status: 404 }) });
  const results = await Promise.all(Array.from({ length: 10 }, () => getOrCreateComposioSession(projectRoot)));
  assert.equal(calls.creates.filter((c) => !isReadConfig(c)).length, 1, "404: one new session for parallel callers");
  assert.ok(results.every((r) => r.sessionId === "trs_new1"));
  assert.equal(readStoreFile().sessionId, "trs_new1");
}

setComposioClientForTest(null);
rmSync(root, { recursive: true, force: true });
console.log("test-composio-session-cache: ok");
