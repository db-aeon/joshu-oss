#!/usr/bin/env npx tsx
/**
 * Unit tests: the access gate of /api/connectors and /api/nylas, and the check of a pushed
 * companion grant (spec connectors-api-access, change connectors-api-access).
 *
 * Usage: npm run test:connectors-api-access
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-api-access-"));
process.env.AROZ_DATA = path.join(tmp, "aroz");
process.env.JOSHU_AROZ_USER = "owner@example.com";
delete process.env.JOSHU_FILES_ROOT;

const { companionGrantPushAllowed, registerConnectorsApiAccess } = await import("../src/connectors/apiAccess.js");
const { registerNylasRoutes } = await import("../src/nylas/routes.js");
const { readAgentGrant } = await import("../src/nylas/store.js");

/** Fake session check: the header x-test-session stands for a valid desktop session. */
const allowRequest = async (req) => req.headers["x-test-session"] === "ok";

const router = express.Router();
router.use(express.json());
registerConnectorsApiAccess(router, { allowRequest });
let disconnectRuns = 0;
router.get("/api/connectors/mail/gmail/search", (_req, res) => res.json({ hits: [{ subject: "secret" }] }));
router.get("/api/connectors/status", (_req, res) => res.json({ gmail: { accounts: [] } }));
router.post("/api/connectors/composio/disconnect", (_req, res) => {
  disconnectRuns += 1;
  res.json({ ok: true });
});
router.get("/api/research/ping", (_req, res) => res.json({ ok: true }));
let completeRuns = 0;
router.get("/api/onboarding/draft", (_req, res) => res.json({ draft: { ownerName: "secret" } }));
router.post("/api/onboarding/complete", (_req, res) => {
  completeRuns += 1;
  res.json({ ok: true });
});
registerNylasRoutes(router, { projectRoot: tmp });

const app = express();
app.use("/joshu", router);
app.use(router);
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, urlPath, { session = false, body } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...(session ? { "x-test-session": "ok" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  // --- Scenario: An anonymous search from the internet -----------------------------------
  for (const p of ["/joshu/api/connectors/mail/gmail/search?q=verify", "/api/connectors/mail/gmail/search?q=verify"]) {
    const r = await call("GET", p);
    assert.equal(r.status, 401, p);
    assert.deepEqual(r.json, { error: "desktop_session_required" }, "no box data in the answer");
  }
  assert.equal((await call("GET", "/joshu/api/connectors/status")).status, 401);
  assert.equal((await call("GET", "/joshu/api/nylas/status")).status, 401);
  assert.equal((await call("GET", "/joshu/api/nylas/messages")).status, 401);

  // --- Scenario: An anonymous change from the internet -----------------------------------
  assert.equal((await call("POST", "/joshu/api/connectors/composio/disconnect", { body: { toolkit: "gmail" } })).status, 401);
  assert.equal(disconnectRuns, 0, "the route did not run");
  assert.equal((await call("POST", "/joshu/api/nylas/agent", { body: { email: "x@example.com" } })).status, 401);

  // --- Scenario: The onboarding routes ---------------------------------------------------
  assert.equal((await call("GET", "/joshu/api/onboarding/draft")).status, 401);
  assert.equal((await call("POST", "/joshu/api/onboarding/complete", { body: { ownerName: "x" } })).status, 401);
  assert.equal(completeRuns, 0, "onboarding complete did not run");
  assert.equal((await call("GET", "/joshu/api/onboarding/draft", { session: true })).status, 200);

  // --- Scenarios: The connectors MCP on the box, and a browser app of the owner -----------
  const ok = await call("GET", "/joshu/api/connectors/mail/gmail/search?q=verify", { session: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.hits.length, 1);
  assert.equal((await call("GET", "/joshu/api/connectors/status", { session: true })).status, 200);

  // Paths outside the two prefixes are not gated by this change.
  assert.equal((await call("GET", "/joshu/api/research/ping")).status, 200);

  // --- Requirement: A pushed companion grant cannot replace another companion grant ----------
  // Scenario: The first push of the control plane (no session; the gate lets the route run).
  const first = await call("POST", "/joshu/api/nylas/agent/import", { body: { grantId: "G", email: "Agent@Example.com" } });
  assert.equal(first.status, 200);
  assert.equal(readAgentGrant(tmp)?.grantId, "G");

  // Scenario: The same push again on the next heartbeat.
  const again = await call("POST", "/joshu/api/nylas/agent/import", { body: { grantId: "G", email: "agent@example.com" } });
  assert.equal(again.status, 200);
  assert.equal(readAgentGrant(tmp)?.grantId, "G");

  // Scenario: A push of another grant.
  const other = await call("POST", "/joshu/api/nylas/agent/import", { body: { grantId: "H", email: "evil@example.com" } });
  assert.equal(other.status, 409);
  assert.deepEqual(other.json, { error: "grant_already_set" });
  assert.equal(readAgentGrant(tmp)?.grantId, "G", "the saved companion grant stays G");
  // The same path also works without the /joshu base.
  assert.equal((await call("POST", "/api/nylas/agent/import", { body: { grantId: "H", email: "evil@example.com" } })).status, 409);

  // companionGrantPushAllowed directly.
  assert.equal(companionGrantPushAllowed(null, { grantId: "G", email: "a@b.c" }), true);
  assert.equal(companionGrantPushAllowed({ grantId: "G", email: "a@b.c" }, { grantId: "G", email: "A@B.C" }), true);
  assert.equal(companionGrantPushAllowed({ grantId: "G", email: "a@b.c" }, { grantId: "G", email: "x@b.c" }), false);
  assert.equal(companionGrantPushAllowed({ grantId: "G", email: "a@b.c" }, { grantId: "H", email: "a@b.c" }), false);

  // --- The real session check: direct localhost passes, a request through Caddy does not ----
  const realRouter = express.Router();
  registerConnectorsApiAccess(realRouter);
  realRouter.get("/api/connectors/status", (_req, res) => res.json({ ok: true }));
  const realApp = express();
  realApp.use("/joshu", realRouter);
  const realServer = await new Promise((resolve) => {
    const s = realApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const realBase = `http://127.0.0.1:${realServer.address().port}`;
    const local = await fetch(`${realBase}/joshu/api/connectors/status`);
    assert.equal(local.status, 200, "the connectors MCP on localhost passes");
    process.env.CUSTOMER_DOMAIN = "box.example.test";
    process.env.PUBLIC_AROZ_PORT = "1";
    const viaCaddy = await fetch(`${realBase}/joshu/api/connectors/status`, {
      headers: { "x-forwarded-for": "203.0.113.1", cookie: "forged-cookie", "sec-fetch-site": "same-origin" },
    });
    assert.equal(viaCaddy.status, 401, "a forwarded request with a cookie that ArozOS does not accept fails");
  } finally {
    realServer.close();
  }

  console.log("test-connectors-api-access: ok");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
