#!/usr/bin/env npx tsx
/**
 * Unit tests: the heartbeat loop of the instance agent keeps running when a round fails.
 *
 * Usage: npm run test:instance-agent-heartbeat
 */
import assert from "node:assert/strict";

import { runHeartbeatLoop } from "../packages/instance-agent/src/heartbeat.js";

/** Runs the loop with fake timers. `rounds` gives the result of each round in order. */
async function runRounds(rounds) {
  const scheduled = [];
  const warnings = [];
  let calls = 0;
  const deps = {
    round: async () => {
      const step = rounds[calls++];
      if (step instanceof Error) throw step;
      return step;
    },
    fallbackMs: 30_000,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    warn: (message) => warnings.push(message),
  };
  await runHeartbeatLoop(deps);
  while (calls < rounds.length) {
    const next = scheduled.at(-1);
    await next.fn();
    // The scheduled function starts the next round without awaiting it.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { scheduled: scheduled.map((s) => s.ms), warnings, calls };
}

// A network error (fetch failed) does not reject and does not end the loop.
{
  const fetchFailed = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Client network socket disconnected"), { code: "ECONNRESET" }),
  });
  const { scheduled, warnings, calls } = await runRounds([fetchFailed, 15_000]);
  assert.equal(calls, 2);
  assert.deepEqual(scheduled, [30_000, 15_000]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /heartbeat round failed: fetch failed \(ECONNRESET: Client network socket disconnected\)/);
}

// A response that is not ok (the round throws) schedules the next round with the fallback delay.
{
  const { scheduled, warnings, calls } = await runRounds([
    new Error("control plane answered 503"),
    new Error("control plane answered 503"),
    20_000,
  ]);
  assert.equal(calls, 3);
  assert.deepEqual(scheduled, [30_000, 30_000, 20_000]);
  assert.equal(warnings.length, 2);
}

// A good round uses the delay of the control plane; a missing or bad delay uses the fallback.
{
  const { scheduled, warnings } = await runRounds([60_000, undefined, Number.NaN, 0]);
  assert.deepEqual(scheduled, [60_000, 30_000, 30_000, 30_000]);
  assert.equal(warnings.length, 0);
}

// The first round can be awaited, as startInstanceAgent does: it resolves even when it fails.
{
  const scheduled = [];
  await runHeartbeatLoop({
    round: async () => {
      throw new Error("boom");
    },
    fallbackMs: 5_000,
    schedule: (_fn, ms) => scheduled.push(ms),
    warn: () => {},
  });
  assert.deepEqual(scheduled, [5_000]);
}

console.log("instance agent heartbeat: ok");
