#!/usr/bin/env npx tsx
/**
 * Hermes gateway restarts wait while turns are in flight or the owner is on a
 * live call (canary box 2026-09-26: five restarts under live turns), and go
 * ahead once idle or after the deferral cap.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

const home = await mkdtemp(path.join(tmpdir(), "joshu-hermes-home-"));
process.env.HERMES_HOME = home;

const { HermesApiRunner } = await import("../src/hermesApi.ts");

try {
  const runner = new HermesApiRunner({
    binary: "hermes",
    apiBaseUrl: "http://127.0.0.1:1",
    apiKey: "test",
    autoStartGateway: false,
  });
  const defer = (reason) => runner["deferGatewayRestartIfBusy"](reason);

  assert.equal(await defer("idle"), false, "idle gateway restarts right away");

  runner["inFlightTurns"] = 1;
  assert.equal(await defer("MCP catalog refresh"), true, "a turn in flight defers the restart");
  runner["inFlightTurns"] = 0;
  assert.equal(await defer("MCP catalog refresh"), false, "turn finished — restart now (ends the deferral window)");

  let onCall = true;
  runner.addGatewayBusyProbe(async () => (onCall ? "owner is on a live call" : undefined));
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-27T00:15:00Z") });
  assert.equal(await defer("cloud browser CDP"), true, "a live call defers the restart");
  mock.timers.setTime(Date.parse("2026-09-27T00:20:00Z"));
  assert.equal(await defer("cloud browser CDP"), true, "still deferring inside the cap");
  mock.timers.setTime(Date.parse("2026-09-27T00:26:00Z"));
  assert.equal(await defer("cloud browser CDP"), false, "after the cap the restart goes ahead");
  onCall = false;
  assert.equal(await defer("MCP catalog refresh"), false, "idle again");
  mock.timers.reset();

  // applyConfigAndAwaitGatewayRestart (change slack-connect): resolves only when a
  // new gateway process answers, tells the caller once while a busy gateway waits,
  // and keeps the busy wait (it never restarts by itself).
  runner["applyConfigAndReloadGatewayInBackground"] = async () => undefined;
  runner["health"] = async () => true;
  assert.deepEqual(
    await runner.applyConfigAndAwaitGatewayRestart("test", { pollMs: 1 }),
    { restarted: false },
    "auto-start off: nothing to wait for",
  );
  runner["gatewayAutoStart"] = true;
  runner["inFlightTurns"] = 1;
  const waiting = [];
  const restart = runner.applyConfigAndAwaitGatewayRestart("Slack settings", {
    pollMs: 2,
    onWaiting: (busy) => waiting.push(busy),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(waiting, ["1 Hermes turn(s) in flight"], "onWaiting gets the busy reason once");
  runner["inFlightTurns"] = 0;
  runner["gatewayStartCount"] += 1;
  assert.deepEqual(await restart, { restarted: true }, "resolves after a new gateway process answers");
  assert.deepEqual(
    await runner.applyConfigAndAwaitGatewayRestart("no start", { pollMs: 1, timeoutMs: 15 }),
    { restarted: false },
    "times out when no new gateway process starts",
  );
  runner["gatewayAutoStart"] = false;

  console.log("test-gateway-restart-guard: ok");
} finally {
  mock.timers.reset();
  await rm(home, { recursive: true, force: true });
}
