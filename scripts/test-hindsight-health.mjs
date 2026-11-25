#!/usr/bin/env npx tsx
/**
 * Tests: the `hindsight` component of /api/instance/health reports the real state of Hindsight.
 *
 * Box harley (2026-11-11) had JOSHU_HINDSIGHT_ENABLED=false, no Hindsight process, and no
 * Postgres, and /joshu/api/hindsight/status answered 503. The health report still said
 * `components.hindsight.ok: true`, so the fleet failure digest did not show the fault.
 *
 * Usage: npm run test:hindsight-health
 */
import assert from "node:assert/strict";
import { probeHindsightHealth } from "../src/hindsightHealth.ts";

const NAMES = [
  "JOSHU_HINDSIGHT_ENABLED",
  "HINDSIGHT_API_LLM_API_KEY",
  "HINDSIGHT_API_LLM_PROVIDER",
  "HINDSIGHT_API_LLM_BASE_URL",
];
function setEnv(values) {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, values);
}

const calls = [];
function fakeFetch(answer) {
  return async (url) => {
    calls.push(String(url));
    if (answer instanceof Error) throw answer;
    return new Response("{}", { status: answer });
  };
}

// 1. Disabled (the harley case): ok false, no call to Hindsight.
setEnv({ JOSHU_HINDSIGHT_ENABLED: "false", HINDSIGHT_API_LLM_API_KEY: "k" });
calls.length = 0;
assert.deepEqual(await probeHindsightHealth("http://127.0.0.1:8888", { fetchImpl: fakeFetch(200) }), {
  ok: false,
  enabled: false,
  reason: "disabled",
});
assert.equal(calls.length, 0);

// 2. Enabled and healthy.
setEnv({ JOSHU_HINDSIGHT_ENABLED: "true" });
calls.length = 0;
assert.deepEqual(await probeHindsightHealth("http://127.0.0.1:8888/", { fetchImpl: fakeFetch(200) }), {
  ok: true,
  enabled: true,
});
assert.deepEqual(calls, ["http://127.0.0.1:8888/health"]);

// 3. Enabled, health answers 503.
assert.deepEqual(await probeHindsightHealth("http://127.0.0.1:8888", { fetchImpl: fakeFetch(503) }), {
  ok: false,
  enabled: true,
  reason: "health HTTP 503",
});

// 4. Enabled, nothing listens (no Hindsight process).
const down = await probeHindsightHealth("http://127.0.0.1:8888", {
  fetchImpl: fakeFetch(new Error("fetch failed")),
});
assert.equal(down.ok, false);
assert.equal(down.enabled, true);
assert.match(down.reason, /^unreachable: fetch failed/);

// 5. Auto mode follows the LLM configuration.
setEnv({});
assert.equal((await probeHindsightHealth("http://x", { fetchImpl: fakeFetch(200) })).reason, "disabled");
setEnv({ JOSHU_HINDSIGHT_ENABLED: "auto", HINDSIGHT_API_LLM_API_KEY: "k" });
assert.deepEqual(await probeHindsightHealth("http://x", { fetchImpl: fakeFetch(200) }), { ok: true, enabled: true });

console.log("ok hindsight health");
