#!/usr/bin/env node
/**
 * Unit tests for cloud browser idle / orphan reconcile logic.
 */
import assert from "node:assert/strict";

process.env.CONTROL_PLANE_URL = "https://cp.test";
process.env.INSTANCE_AGENT_TOKEN = "test-token";
process.env.JOSHU_INSTANCE_ID = "inst-1";

const remoteSession = {
  browserId: "bu-123",
  cdpUrl: "wss://cdp.test/session",
  liveUrl: "https://live.test/view",
  timeoutAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};

let remoteActive = true;
/** Whether the Browser Use CDP discovery endpoint answers (false = browser gone, 502). */
let cdpAlive = true;
let fetchCalls = [];
function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

global.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), init });
  const u = String(url);
  if (u.endsWith("/api/instances/browser-use/browsers") && init.method === "GET") {
    if (!remoteActive) return mockResponse(404, { error: "browser_not_running" });
    return mockResponse(200, { ok: true, ...remoteSession });
  }
  if (u.endsWith("/api/instances/browser-use/browsers") && init.method === "POST") {
    const body = JSON.parse(String(init.body || "{}"));
    if (body.action === "stop") {
      remoteActive = false;
      return mockResponse(200, { ok: true, stopped: true });
    }
    remoteActive = true;
    return mockResponse(200, { ok: true, ...remoteSession });
  }
  if (u.endsWith("/json/version")) {
    return mockResponse(cdpAlive ? 200 : 502, cdpAlive ? { Browser: "Chrome" } : {});
  }
  throw new Error(`unexpected fetch ${u} ${init.method ?? "GET"}`);
};

const mod = await import("../dist/cloudBrowser.js");
const {
  resetCloudBrowserStateForTests,
  startCloudBrowserLifecycle,
  reconcileCloudBrowserState,
  stopCloudBrowser,
  cloudBrowserSessionActive,
  cloudBrowserIdleTimeoutMs,
} = mod;

async function settle(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

resetCloudBrowserStateForTests();
remoteActive = true;
assert.equal(cloudBrowserIdleTimeoutMs(), 300_000);

startCloudBrowserLifecycle({
  idleMs: 1000,
  busy: () => false,
  onCdp: async () => {},
});
await settle();
// Simulate stack restart: in-memory session cleared but CP browser still billing.
remoteActive = true;
fetchCalls = [];
await reconcileCloudBrowserState();
assert.equal(fetchCalls.some((c) => c.init.method === "GET"), true);
assert.equal(
  fetchCalls.some((c) => c.init.method === "POST" && JSON.parse(c.init.body).action === "stop"),
  true,
);
assert.equal(cloudBrowserSessionActive(), false);

remoteActive = true;
resetCloudBrowserStateForTests();
startCloudBrowserLifecycle({
  idleMs: 1000,
  busy: () => true,
  onCdp: async () => {},
});
await settle();
fetchCalls = [];
await reconcileCloudBrowserState();
assert.equal(cloudBrowserSessionActive(), true);
assert.equal(
  fetchCalls.some((c) => c.init.method === "POST" && JSON.parse(c.init.body).action === "stop"),
  false,
);

remoteActive = true;
resetCloudBrowserStateForTests();
startCloudBrowserLifecycle({
  idleMs: 999_999,
  busy: () => false,
  onCdp: async () => {},
});
await mod.ensureCloudBrowser();
assert.equal(cloudBrowserSessionActive(), true);
fetchCalls = [];
await stopCloudBrowser();
assert.equal(
  fetchCalls.some((c) => c.init.method === "POST" && JSON.parse(c.init.body).action === "stop"),
  true,
);
assert.equal(cloudBrowserSessionActive(), false);

// --- ensureLiveCloudBrowser (Hermes browser_* wake / self-heal) ---
const { ensureLiveCloudBrowser, expireCloudBrowserProbeForTests, cloudCdpUrl, hermesBrowserActivityRecent } = mod;
const ensurePosts = () =>
  fetchCalls.filter((c) => c.init.method === "POST" && JSON.parse(c.init.body).action === "ensure").length;
const probes = () => fetchCalls.filter((c) => c.url.endsWith("/json/version")).length;

// No session (idle-stopped): ensure provisions one and counts as Hermes activity.
resetCloudBrowserStateForTests();
const retargets = [];
startCloudBrowserLifecycle({
  idleMs: 999_999,
  busy: () => false,
  onCdp: async (url) => {
    retargets.push(url);
  },
});
remoteActive = false;
cdpAlive = true;
fetchCalls = [];
const woke = await ensureLiveCloudBrowser();
assert.equal(woke.cdpUrl, remoteSession.cdpUrl);
assert.equal(ensurePosts(), 1);
assert.equal(cloudBrowserSessionActive(), true);
assert.equal(hermesBrowserActivityRecent(5_000), true);
assert.deepEqual(retargets, [remoteSession.cdpUrl]);

// Fresh session: trusted without a probe or CP round trip; concurrent calls share one run.
fetchCalls = [];
const [a, b] = await Promise.all([ensureLiveCloudBrowser(), ensureLiveCloudBrowser()]);
assert.equal(a.cdpUrl, remoteSession.cdpUrl);
assert.equal(b.cdpUrl, remoteSession.cdpUrl);
assert.equal(fetchCalls.length, 0);

// Probe TTL elapsed, browser still up: one probe, no CP ensure.
expireCloudBrowserProbeForTests();
fetchCalls = [];
await ensureLiveCloudBrowser();
assert.equal(probes(), 1);
assert.equal(ensurePosts(), 0);

// Browser died behind our back (Browser Use 502): re-ensure adopts the new CDP URL.
expireCloudBrowserProbeForTests();
cdpAlive = false;
remoteSession.cdpUrl = "wss://cdp.test/session-2";
remoteSession.browserId = "bu-456";
fetchCalls = [];
const healed = await ensureLiveCloudBrowser();
assert.equal(probes(), 1);
assert.equal(ensurePosts(), 1);
assert.equal(healed.cdpUrl, "wss://cdp.test/session-2");
assert.equal(cloudCdpUrl(), "wss://cdp.test/session-2");
assert.deepEqual(retargets, ["wss://cdp.test/session", "wss://cdp.test/session-2"]);
cdpAlive = true;

// Control plane cannot provide a browser: the caller sees the error (route maps it to browser_unavailable).
resetCloudBrowserStateForTests();
startCloudBrowserLifecycle({ idleMs: 999_999, busy: () => false, onCdp: async () => {} });
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  if (String(url).endsWith("/api/instances/browser-use/browsers") && init.method === "POST") {
    return mockResponse(503, { error: "browser_use_create_503" });
  }
  return realFetch(url, init);
};
await assert.rejects(ensureLiveCloudBrowser(), /browser_use_create_503/);
global.fetch = realFetch;
resetCloudBrowserStateForTests();

console.log("test-cloud-browser-lifecycle — all passed");
