#!/usr/bin/env npx tsx
/**
 * Unit checks for browser handoff store, tokens, lock stub, and Hermes patch marker.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { browserHandoffLockStub } from "../src/browserHandoff/lock.ts";
import {
  cancelHandoff,
  completeHandoff,
  createHandoff,
  extendHandoffExpiry,
  getHandoffRecord,
  getPendingHandoff,
  handoffMaxTtlMs,
  handoffStatusMessage,
  markHandoffsBrowserStopped,
  handoffOwnerActivityMs,
  handoffUrlForRecord,
  isBrowserHandoffLocked,
  pendingHandoffBlocksCloudBrowser,
  setHandoffLastScan,
  touchHandoffOwnerActivity,
} from "../src/browserHandoff/store.ts";
import { boxLoginRedirectLocation, sanitizeHandoffReturnPath } from "../src/browserHandoff/boxAuth.ts";
import { mintHandoffToken, mintHandoffAuthToken, verifyHandoffAuthToken, verifyHandoffToken } from "../src/browserHandoff/token.ts";
import {
  catalogForScanPrompt,
  heuristicOverlayScan,
  sanitizeCatalog,
} from "../src/browserHandoff/formCatalog.ts";
import { buildHandoffScanPrompt } from "../src/browserHandoff/formScan.ts";
import { isOauthPopupUrl } from "../src/camofoxSession.ts";
import {
  looksLikeOwnerHandoffComplete,
  smsSessionKeysCompatible,
  tryCompletePendingHandoffForOwnerSession,
  tryCompletePendingHandoffFromOwnerConfirm,
} from "../src/browserHandoff/ownerHandoffConfirm.ts";
import {
  buildSmsHandoffContinuationMessages,
  loadHandoffTaskContext,
} from "../src/browserHandoff/smsContinue.ts";

function tempProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "joshu-handoff-test-"));
}

function rmRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// --- token ---
const id = "00000000-0000-4000-8000-000000000099";
const expMs = Date.now() + 60_000;
const token = mintHandoffToken(id, expMs);
assert.equal(verifyHandoffToken(id, String(expMs), token).ok, true);
assert.equal(verifyHandoffToken(id, String(expMs), "bad").ok, false);
assert.equal(verifyHandoffToken(id, String(Date.now() - 1000), token).ok, false);
const pastExp = Date.now() - 60_000;
const pastTok = mintHandoffToken(id, pastExp);
assert.equal(verifyHandoffToken(id, String(pastExp), pastTok).ok, true);
const authTok = mintHandoffAuthToken(id, expMs);
assert.equal(verifyHandoffAuthToken(id, String(expMs), authTok).ok, true);
assert.equal(verifyHandoffAuthToken(id, String(expMs), token).ok, false);
assert.notEqual(authTok, token);

// --- store lifecycle ---
const root = tempProjectRoot();
try {
  const record = createHandoff(root, {
    pageUrl: "https://example.com/checkout",
    pageTitle: "Checkout",
    instructions: "Review and pay",
  });
  assert.equal(record.status, "pending");
  assert.equal(getPendingHandoff(root)?.id, record.id);

  const lock = isBrowserHandoffLocked(root);
  assert.equal(lock.locked, true);
  assert.equal(lock.handoffId, record.id);

  const stub = browserHandoffLockStub(root);
  assert.equal(stub?.error, "browser_handoff_locked");

  assert.throws(
    () =>
      createHandoff(root, {
        pageUrl: "https://example.com/other",
        pageTitle: "Other",
        instructions: "second",
      }),
    /browser_handoff_already_pending/,
  );

  const url = handoffUrlForRecord(record);
  assert.match(url, /\/handoff\//);
  assert.match(url, /[?&]t=/);
  assert.match(url, /[?&]exp=/);

  assert.ok(record.lastOwnerActivityAt);
  assert.equal(pendingHandoffBlocksCloudBrowser(root), true);

  const extended = extendHandoffExpiry(root, record.id);
  assert.ok(extended);
  assert.ok(Date.parse(extended.expiresAt) >= Date.parse(record.expiresAt));
  assert.ok(extended.lastOwnerActivityAt);

  const completed = completeHandoff(root, record.id);
  assert.equal(completed?.status, "completed");
  assert.equal(isBrowserHandoffLocked(root).locked, false);
  assert.equal(browserHandoffLockStub(root), null);

  const scanRoot = tempProjectRoot();
  try {
    const pending = createHandoff(scanRoot, {
      pageUrl: "https://example.com/login",
      pageTitle: "Login",
      instructions: "sign in",
    });
    const scanned = setHandoffLastScan(scanRoot, pending.id, {
      fieldIds: ["f0-e0", "f0-e1"],
      primaryButtonId: "f0-b0",
      scannedAt: new Date().toISOString(),
    });
    assert.deepEqual(scanned?.lastScan?.fieldIds, ["f0-e0", "f0-e1"]);
    assert.equal(scanned?.lastScan?.primaryButtonId, "f0-b0");
    assert.equal("value" in (scanned?.lastScan ?? {}), false);
  } finally {
    rmRoot(scanRoot);
  }

  const root2 = tempProjectRoot();
  try {
    const pending = createHandoff(root2, {
      pageUrl: "https://example.com/a",
      pageTitle: "A",
      instructions: "pay",
    });
    cancelHandoff(root2, pending.id);
    assert.equal(getHandoffRecord(root2, pending.id)?.status, "cancelled");
  } finally {
    rmRoot(root2);
  }
} finally {
  rmRoot(root);
}

// --- owner activity + cloud-browser idle gate ---
const rootIdle = tempProjectRoot();
try {
  const pending = createHandoff(rootIdle, {
    pageUrl: "https://example.com/checkout",
    pageTitle: "Checkout",
    instructions: "pay",
    ttlMs: 60_000,
  });
  const maxExp = Date.parse(pending.createdAt) + handoffMaxTtlMs();
  for (let i = 0; i < 20; i += 1) {
    extendHandoffExpiry(rootIdle, pending.id);
  }
  const capped = getHandoffRecord(rootIdle, pending.id);
  assert.ok(capped);
  assert.ok(Date.parse(capped.expiresAt) <= maxExp + 1000);

  const staleMs = handoffOwnerActivityMs() + 5_000;
  const staleAt = new Date(Date.now() - staleMs).toISOString();
  fs.writeFileSync(
    path.join(rootIdle, ".joshu", "browser-handoff", `${pending.id}.json`),
    `${JSON.stringify({ ...capped, lastOwnerActivityAt: staleAt }, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(getPendingHandoff(rootIdle)?.id, pending.id, "agent lock still sees pending");
  assert.equal(pendingHandoffBlocksCloudBrowser(rootIdle), false, "stale owner activity releases cloud idle");

  touchHandoffOwnerActivity(rootIdle, pending.id);
  assert.equal(pendingHandoffBlocksCloudBrowser(rootIdle), true);
} finally {
  rmRoot(rootIdle);
}

// --- unopened handoff holds the cloud browser until the link expires ---
const rootUnopened = tempProjectRoot();
try {
  const unopened = createHandoff(rootUnopened, {
    pageUrl: "https://www.aa.com/booking/passengers",
    pageTitle: "Passengers",
    instructions: "pay",
  });
  assert.equal(unopened.ownerOpenedAt, undefined);
  assert.match(handoffStatusMessage(unopened), /has not opened the browser handoff link yet/);
  // 20 minutes later, the owner still has not opened the link (old rule: released after 10).
  const recordFile = path.join(rootUnopened, ".joshu", "browser-handoff", `${unopened.id}.json`);
  const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  const aged = {
    ...unopened,
    createdAt: twentyMinAgo,
    lastOwnerActivityAt: twentyMinAgo,
    expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
  };
  fs.writeFileSync(recordFile, `${JSON.stringify(aged, null, 2)}\n`, { mode: 0o600 });
  assert.equal(pendingHandoffBlocksCloudBrowser(rootUnopened), true, "unopened handoff holds the browser");

  // The owner opens the page: the 10 minute owner-activity rule applies from now on.
  const opened = touchHandoffOwnerActivity(rootUnopened, unopened.id);
  assert.ok(opened?.ownerOpenedAt);
  assert.equal(touchHandoffOwnerActivity(rootUnopened, unopened.id)?.ownerOpenedAt, opened.ownerOpenedAt, "first open is kept");
  assert.match(handoffStatusMessage(opened), /opened the browser handoff page and has not finished/);
  fs.writeFileSync(
    recordFile,
    `${JSON.stringify({ ...opened, lastOwnerActivityAt: twentyMinAgo }, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(pendingHandoffBlocksCloudBrowser(rootUnopened), false, "opened, then idle: released");

  // Idle stop while pending: the stamp and the message tell the companion why the page is gone.
  const [stamped] = markHandoffsBrowserStopped(rootUnopened, "idle");
  assert.equal(stamped?.id, unopened.id);
  assert.equal(stamped.browserStopReason, "idle");
  assert.equal(markHandoffsBrowserStopped(rootUnopened, "idle").length, 0, "stamped once");
  const pendingMsg = handoffStatusMessage(stamped);
  assert.match(pendingMsg, /Joshu stopped the shared browser at .* because nothing used it/);
  assert.match(pendingMsg, /The website did not cause this/);
  assert.match(pendingMsg, /Cancel this browser handoff/);
} finally {
  rmRoot(rootUnopened);
}

// --- expired handoff: never opened, then the idle stop ---
const rootExpired = tempProjectRoot();
try {
  const handoff = createHandoff(rootExpired, {
    pageUrl: "https://www.aa.com/booking/payment",
    pageTitle: "Payment",
    instructions: "pay",
  });
  const recordFile = path.join(rootExpired, ".joshu", "browser-handoff", `${handoff.id}.json`);
  const expiredAt = new Date(Date.now() - 5 * 60_000).toISOString();
  fs.writeFileSync(
    recordFile,
    `${JSON.stringify({ ...handoff, expiresAt: expiredAt }, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(pendingHandoffBlocksCloudBrowser(rootExpired), false, "expired link releases the browser");
  const expired = getHandoffRecord(rootExpired, handoff.id);
  assert.equal(expired?.status, "expired");
  assert.match(handoffStatusMessage(expired), /may be gone/);

  const [stamped] = markHandoffsBrowserStopped(rootExpired, "idle");
  assert.equal(stamped?.status, "expired");
  const msg = handoffStatusMessage(stamped);
  assert.match(msg, /link expired at .* before the owner finished/);
  assert.match(msg, /staged page \(for example a cart or a half-filled form\) is gone/);
  assert.match(msg, /The website did not cause this/);
  assert.match(msg, /offer to stage the page again/);

  // A handoff that ended more than an hour before the stop is not stamped.
  const old = createHandoff(rootExpired, { pageUrl: "https://x.test/", pageTitle: "", instructions: "x" });
  fs.writeFileSync(
    path.join(rootExpired, ".joshu", "browser-handoff", `${old.id}.json`),
    `${JSON.stringify({ ...old, status: "cancelled", cancelledAt: new Date(Date.now() - 2 * 3600_000).toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(markHandoffsBrowserStopped(rootExpired, "shutdown").length, 0);
  assert.match(
    handoffStatusMessage({ ...stamped, browserStopReason: "shutdown" }),
    /because the Joshu service restarted/,
  );
} finally {
  rmRoot(rootExpired);
}

// --- owner confirm (SMS / chat "done") ---
assert.equal(looksLikeOwnerHandoffComplete("Yeah I'm done with rapidapi"), true);
assert.equal(looksLikeOwnerHandoffComplete("done with the login"), true);
assert.equal(looksLikeOwnerHandoffComplete("Can you check Amazon?"), false);
assert.equal(smsSessionKeysCompatible("sms:+13106004336:1", "sms:+13106004336:2"), true);
assert.equal(smsSessionKeysCompatible("sms:+13106004336:1", "jchat:foo"), false);

const rootConfirm = tempProjectRoot();
try {
  const pending = createHandoff(rootConfirm, {
    pageUrl: "https://rapidapi.com/",
    pageTitle: "API Hub",
    instructions: "sign in",
    hermesSessionKey: "sms:+13106004336:1000",
  });
  assert.equal(isBrowserHandoffLocked(rootConfirm).locked, true);
  assert.equal(
    tryCompletePendingHandoffForOwnerSession(rootConfirm, "sms:+13106004336:2000")?.id,
    pending.id,
  );
  assert.equal(getHandoffRecord(rootConfirm, pending.id)?.status, "completed");
  assert.equal(isBrowserHandoffLocked(rootConfirm).locked, false);
} finally {
  rmRoot(rootConfirm);
}

const rootAmazon = tempProjectRoot();
try {
  const pending = createHandoff(rootAmazon, {
    pageUrl: "https://www.amazon.com/ap/signin",
    pageTitle: "Sign in",
    instructions: "log in",
    hermesSessionKey: "sms:+13106004336:1000",
  });
  assert.equal(
    tryCompletePendingHandoffForOwnerSession(rootAmazon, "sms:+13106004336:2000")?.id,
    pending.id,
  );
  assert.equal(
    tryCompletePendingHandoffFromOwnerConfirm(rootAmazon, {
      body: "Can you check Amazon?",
      hermesSessionKey: "sms:+13106004336:3000",
    }),
    null,
  );
} finally {
  rmRoot(rootAmazon);
}

// --- Hermes patch script smoke ---
const cdpPatch = fs.readFileSync(
  path.join(process.cwd(), "scripts/patch-hermes-browser-cdp-guards.mjs"),
  "utf8",
);
assert.match(cdpPatch, /hitl_browser_cdp_guards/);
assert.match(cdpPatch, /joshu_cloud_browser_touch/);
assert.match(cdpPatch, /joshu_cloud_browser_ensure_v3/);
assert.match(cdpPatch, /browser_restarted/);
assert.match(cdpPatch, /\/api\/browser\/ensure/);
assert.match(cdpPatch, /browser_navigate/);
assert.match(cdpPatch, /"browser_snapshot"/);
assert.doesNotMatch(cdpPatch, /camofox_snapshot/);

const routesSrc = fs.readFileSync(path.join(process.cwd(), "src/browserHandoff/routes.ts"), "utf8");
assert.match(routesSrc, /\/page-key/);
assert.match(routesSrc, /readFormSignature/);

const scanSrc = fs.readFileSync(path.join(process.cwd(), "src/browserHandoff/formScan.ts"), "utf8");
assert.doesNotMatch(scanSrc, /fillForm|fill-form|camofoxSession/);
assert.match(scanSrc, /catalogForScanPrompt/);

const secretCatalog = {
  fields: [
    {
      id: "f0-e0",
      tag: "INPUT",
      type: "email",
      name: "email",
      elementId: "ap_email",
      autocomplete: "email",
      placeholder: "Email",
      label: "Email",
      value: "owner@example.com",
    },
    {
      id: "f0-e1",
      tag: "INPUT",
      type: "password",
      name: "password",
      elementId: "ap_password",
      autocomplete: "current-password",
      placeholder: "Password",
      label: "Password",
      value: "secret123",
    },
  ],
  buttons: [
    { id: "f0-b0", text: "Continue", type: "submit", ariaLabel: "" },
    { id: "f0-b1", text: "Cancel", type: "button", ariaLabel: "" },
  ],
};
const sanitized = sanitizeCatalog(secretCatalog);
assert.equal(sanitized.fields[0].value, undefined);
assert.equal(sanitized.fields[1].value, undefined);
const promptJson = catalogForScanPrompt(secretCatalog);
assert.equal("value" in promptJson.fields[0], false);
assert.equal("value" in promptJson.fields[1], false);
const prompt = buildHandoffScanPrompt(secretCatalog);
assert.doesNotMatch(prompt.user, /secret123/);
assert.doesNotMatch(prompt.user, /owner@example.com/);
assert.match(prompt.user, /f0-e0/);
assert.match(prompt.system, /Never ask for or echo field values/);

const overlay = heuristicOverlayScan(secretCatalog);
assert.equal(overlay.fields[0].inputType, "email");
assert.equal(overlay.fields[1].inputType, "password");
assert.equal(overlay.primaryButtonId, "f0-b0");
assert.equal(overlay.fields[0].prefill, "owner@example.com");
assert.equal(overlay.fields[1].prefill, undefined);

// --- box login return path (open-redirect lock) ---
const handoffPath =
  "/joshu/handoff/b68eb2db-cae8-4d13-aa57-9d47bc31a79f?t=abc&exp=1";
assert.equal(sanitizeHandoffReturnPath(handoffPath), handoffPath);
assert.equal(sanitizeHandoffReturnPath("https://evil.example/joshu/handoff/x"), "");
assert.equal(sanitizeHandoffReturnPath("//evil.example"), "");
assert.equal(sanitizeHandoffReturnPath("/login.html"), "");
assert.equal(sanitizeHandoffReturnPath("/joshu/api/status"), "");
assert.match(boxLoginRedirectLocation(handoffPath), /^\/login\.html\?redirect=/);
assert.match(boxLoginRedirectLocation(handoffPath), /handoff/);

const loginHtml = fs.readFileSync(
  path.join(process.cwd(), "arozos/web-overlays-vanilla/login.html"),
  "utf8",
);
assert.match(loginHtml, /safeHandoffReturnPath/);
assert.match(loginHtml, /handoffReturn/);

const shellJs = fs.readFileSync(path.join(process.cwd(), "public/handoff.js"), "utf8");
assert.match(shellJs, /More Options/);
assert.match(shellJs, /overlayHasOwnerEdits/);
assert.match(shellJs, /joshu-mark\.svg/);
assert.doesNotMatch(shellJs, /Finish in browser/);

const routesSrcNow = fs.readFileSync(path.join(process.cwd(), "src/browserHandoff/routes.ts"), "utf8");
assert.match(routesSrcNow, /\/api\/browser-handoff\/:id\/login/);
assert.match(routesSrcNow, /sendHandoffLoginPage/);
assert.match(routesSrcNow, /verifyArozosPassword/);

const loginJs = fs.readFileSync(path.join(process.cwd(), "public/handoff-login.js"), "utf8");
assert.match(loginJs, /invalid_credentials/);

assert.equal(isOauthPopupUrl("https://accounts.google.com/gsi/transform"), true);
assert.equal(isOauthPopupUrl("https://rapidapi.com/auth/login"), false);

// --- SMS continuation: the handoff brief and the request go in a system message (issue #71) ---
{
  const root = tempProjectRoot();
  const goalsDir = path.join(root, "goals");
  fs.mkdirSync(goalsDir, { recursive: true });
  fs.writeFileSync(
    path.join(goalsDir, "state.json"),
    JSON.stringify({
      version: 1,
      goals: [{ id: "6f993e82", objective: "check X for new direct messages", kanbanTaskId: "t_5273f623" }],
    }),
  );
  const previousDir = process.env.JOSHU_REALTIME_GOALS_STATE_DIR;
  process.env.JOSHU_REALTIME_GOALS_STATE_DIR = goalsDir;
  try {
    const brief = "X is asking for your 4-digit DM passcode. Type your 4-digit passcode in the boxes, then tap I'm done.";
    const record = {
      id: "f24cd860-0000-4000-8000-000000000001",
      status: "completed",
      pageUrl: "https://x.com/i/chat/pin/recovery",
      pageTitle: "X passcode",
      instructions: brief,
      kanbanTaskId: "t_5273f623",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const calls = [];
    const bridge = async (payload) => {
      calls.push(payload);
      return { success: true, task: { title: "Check X for new direct messages", body: "Owner texted: check X for new DMs." } };
    };
    const context = await loadHandoffTaskContext(root, record, bridge);
    assert.equal(context.objective, "check X for new direct messages");
    assert.equal(context.taskTitle, "Check X for new direct messages");
    assert.deepEqual(calls[0], { action: "show", board: "realtime-goals", task_id: "t_5273f623" });

    const messages = buildSmsHandoffContinuationMessages(record, context);
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    assert.match(system, /check X for new direct messages/);
    assert.match(system, /Kanban task t_5273f623: Check X for new direct messages/);
    assert.ok(system.includes(brief), "handoff brief is in the system message");
    assert.match(system, /you wrote it for the owner/);
    assert.ok(!user.includes(brief), "handoff brief is not in a user message");
    assert.doesNotMatch(user, /passcode/);

    // A bridge error leaves the Kanban task out; the objective stays.
    const failing = await loadHandoffTaskContext(root, record, async () => {
      throw new Error("bridge down");
    });
    assert.deepEqual(failing, { objective: "check X for new direct messages" });

    // No Kanban task id: no lookups, and the brief still goes in the system message.
    const bare = { ...record, kanbanTaskId: undefined };
    assert.deepEqual(await loadHandoffTaskContext(root, bare, bridge), {});
    assert.equal(calls.length, 1, "no bridge call without a Kanban task id");
    const bareMessages = buildSmsHandoffContinuationMessages(bare, {});
    assert.ok(bareMessages[0].content.includes(brief));
    assert.doesNotMatch(bareMessages[0].content, /request:|Kanban task/);
  } finally {
    if (previousDir === undefined) delete process.env.JOSHU_REALTIME_GOALS_STATE_DIR;
    else process.env.JOSHU_REALTIME_GOALS_STATE_DIR = previousDir;
    rmRoot(root);
  }
}

// Plugin joshu-browser-handoff sends the worker's Kanban task id when the model gives none.
const handoffPluginSrc = fs.readFileSync(
  path.join(process.cwd(), ".hermes/plugins/joshu-browser-handoff/tools.py"),
  "utf8",
);
assert.match(handoffPluginSrc, /args\.get\("kanban_task_id"\) or os\.environ\.get\("HERMES_KANBAN_TASK"\)/);

// Skill joshu-browser-handoff forbids asking the owner to send a secret (issue #72).
const handoffSkill = fs.readFileSync(
  path.join(process.cwd(), "integrations/hermes/skills/browser/joshu-browser-handoff/SKILL.md"),
  "utf8",
);
assert.match(handoffSkill, /### Never ask the owner to send a secret/);
assert.match(handoffSkill, /password, passcode, PIN, recovery code, or one-time code/);

console.log("browser-handoff fixtures: ok");
