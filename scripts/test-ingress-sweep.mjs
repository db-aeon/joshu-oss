#!/usr/bin/env npx tsx
/**
 * Unit tests: ingress sweep (change stale-ingress-sweep) with a fake Kanban bridge.
 * The bridge action itself has its own test: scripts/test-ingress-sweep-bridge.py.
 *
 * Usage: npm run test:ingress-sweep
 */
import assert from "node:assert/strict";
import {
  ingressSweepAgeHours,
  runIngressSweepOnce,
  sweepStaleIngressTasks,
} from "../src/ea/ingressSweep.ts";

// Age limit: default 48, 0 turns the ingress sweep off, a bad value falls back to 48.
assert.equal(ingressSweepAgeHours({}), 48);
assert.equal(ingressSweepAgeHours({ JOSHU_INGRESS_SWEEP_HOURS: "0" }), 0);
assert.equal(ingressSweepAgeHours({ JOSHU_INGRESS_SWEEP_HOURS: "72" }), 72);
assert.equal(ingressSweepAgeHours({ JOSHU_INGRESS_SWEEP_HOURS: "abc" }), 48);
assert.equal(ingressSweepAgeHours({ JOSHU_INGRESS_SWEEP_HOURS: "-5" }), 48);

// The call sends the right payload and reads the result.
{
  const calls = [];
  const call = async (payload) => {
    calls.push(payload);
    return { success: true, archived: ["t_a", "t_b"], remaining: 7 };
  };
  const result = await sweepStaleIngressTasks(call, {});
  assert.deepEqual(result, { off: false, archived: 2, remaining: 7 });
  assert.deepEqual(calls, [
    { action: "archive_stale_blocked", board: "ea-mail-ingress", max_age_seconds: 48 * 3600, limit: 100 },
  ]);
}

// Off switch: no bridge call.
{
  let called = false;
  const result = await sweepStaleIngressTasks(async () => ((called = true), { success: true }), {
    JOSHU_INGRESS_SWEEP_HOURS: "0",
  });
  assert.equal(result.off, true);
  assert.equal(called, false);
}

// A bridge failure (for example an old bridge script) throws from the sweep and only logs from the run.
{
  const failing = async () => ({ success: false, error: "unknown action: archive_stale_blocked" });
  await assert.rejects(sweepStaleIngressTasks(failing, {}), /unknown action/);
  const lines = [];
  const result = await runIngressSweepOnce(failing, {}, { warn: (line) => lines.push(line) });
  assert.equal(result, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ingress sweep failed: unknown action/);
}

// The log line has a count only, and only when a task was archived.
{
  const lines = [];
  const log = { warn: (line) => lines.push(line) };
  await runIngressSweepOnce(async () => ({ success: true, archived: [], remaining: 0 }), {}, log);
  assert.equal(lines.length, 0);
  await runIngressSweepOnce(async () => ({ success: true, archived: ["t_secret_id"], remaining: 0 }), {}, log);
  assert.deepEqual(lines, ["[hermes-api] ingress sweep archived 1 task(s), 0 left"]);
}

// A run that starts while the previous run is still going does nothing.
{
  let release;
  let calls = 0;
  const slow = () =>
    new Promise((resolve) => {
      calls += 1;
      release = () => resolve({ success: true, archived: [], remaining: 0 });
    });
  const first = runIngressSweepOnce(slow, {}, { warn() {} });
  const second = await runIngressSweepOnce(slow, {}, { warn() {} });
  assert.equal(second, null);
  assert.equal(calls, 1);
  release();
  await first;
  await runIngressSweepOnce(async () => ({ success: true, archived: [], remaining: 0 }), {}, { warn() {} });
}

console.log("test-ingress-sweep: ok");
