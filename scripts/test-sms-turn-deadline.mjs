#!/usr/bin/env node
/**
 * Unit tests for the SMS turn deadline (src/smsTurnDeadline.ts) and the hand-off
 * of a stopped SMS turn to a realtime goal (continueStoppedSmsTurn).
 */
import assert from "node:assert/strict";

import {
  smsTurnDeadline,
  smsTurnStopReason,
  SmsTurnStopped,
  stoppedSmsTurnObjective,
} from "../src/smsTurnDeadline.ts";
import {
  resolveSmsHermesMaxMs,
  resolveSmsHermesStallMs,
  resolveSmsHermesTimeoutMs,
} from "../src/twilioSmsConfig.ts";
import { continueStoppedSmsTurn } from "../src/twilioSmsGateway.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

/** Deadline on a fake clock: 300 s check time, 180 s stall time, 20 min limit. */
function fakeDeadline() {
  let clock = 0;
  const deadline = smsTurnDeadline({
    checkAfterMs: 300_000,
    stallMs: 180_000,
    maxMs: 1_200_000,
    checkEveryMs: 5,
    now: () => clock,
  });
  return {
    deadline,
    advance: async (ms, { progressEveryMs } = {}) => {
      if (!progressEveryMs) {
        clock += ms;
        await tick();
        return;
      }
      for (let done = 0; done < ms; done += progressEveryMs) {
        clock += progressEveryMs;
        deadline.progress();
      }
      await tick();
    },
  };
}

// --- Defaults ---
for (const name of ["JOSHU_SMS_HERMES_TIMEOUT_MS", "JOSHU_SMS_HERMES_STALL_MS", "JOSHU_SMS_HERMES_MAX_MS"]) {
  delete process.env[name];
}
assert.equal(resolveSmsHermesTimeoutMs(), 300_000);
assert.equal(resolveSmsHermesStallMs(), 180_000);
assert.equal(resolveSmsHermesMaxMs(), 1_200_000);
process.env.JOSHU_SMS_HERMES_STALL_MS = "5";
assert.equal(resolveSmsHermesStallMs(), 30_000, "stall time has a floor");
delete process.env.JOSHU_SMS_HERMES_STALL_MS;

// --- No progress at all: nothing stops the SMS turn before the progress check time ---
{
  const { deadline, advance } = fakeDeadline();
  await advance(299_000);
  assert.equal(deadline.signal.aborted, false, "no abort before the progress check time");
  await advance(2_000);
  const stop = smsTurnStopReason(deadline.signal);
  assert.ok(stop instanceof SmsTurnStopped);
  assert.equal(stop.cause, "stalled", "no progress for 301 s after the check time stops the turn");
  deadline.dispose();
}

// --- Steady tool progress: the SMS turn continues past 300 s ---
{
  const { deadline, advance } = fakeDeadline();
  await advance(8 * 60_000, { progressEveryMs: 5_000 });
  assert.equal(deadline.signal.aborted, false, "an 8 minute checkout with steady progress runs on");
  // Progress stops at minute 8: the turn stops once the last progress is 180 s old.
  await advance(170_000);
  assert.equal(deadline.signal.aborted, false);
  await advance(10_000);
  assert.equal(smsTurnStopReason(deadline.signal)?.cause, "stalled");
  assert.equal(smsTurnStopReason(deadline.signal)?.elapsedMs, 8 * 60_000 + 180_000);
  deadline.dispose();
}

// --- Progress at minute 2, then silence: stops at the progress check time ---
{
  const { deadline, advance } = fakeDeadline();
  await advance(120_000);
  deadline.progress();
  await advance(180_000);
  assert.equal(smsTurnStopReason(deadline.signal)?.cause, "stalled", "stops at 5 minutes");
  deadline.dispose();
}

// --- Progress forever: stops at the limit ---
{
  const { deadline, advance } = fakeDeadline();
  await advance(1_190_000, { progressEveryMs: 10_000 });
  assert.equal(deadline.signal.aborted, false);
  await advance(10_000, { progressEveryMs: 10_000 });
  assert.equal(smsTurnStopReason(deadline.signal)?.cause, "limit");
  deadline.dispose();
}

// --- Another abort reason is not a deadline stop ---
{
  const controller = new AbortController();
  controller.abort(new Error("other"));
  assert.equal(smsTurnStopReason(controller.signal), undefined);
}

// --- Stopped SMS turn becomes a realtime goal ---
const stop = new SmsTurnStopped("stalled", 9 * 60_000);
const objective = stoppedSmsTurnObjective("book the 11:25 flight", stop);
assert.ok(objective.startsWith("book the 11:25 flight\n"));
assert.match(objective, /SMS turn worked on this request for 9 minutes/);
assert.match(objective, /Check the current state first/);

const origin = {
  channel: "sms",
  sessionKey: "sms:+15550001111",
  sessionId: "sms:+15550001111:1",
  messageId: "SM123",
  replyAddress: "+15550001111",
};
const deferred = [];
const broker = {
  defer: async (input, title, opts) => {
    deferred.push({ input, title, opts });
    return { id: "g1", intakeReply: opts?.intakeReply };
  },
};
const reply = await continueStoppedSmsTurn(broker, origin, "book the 11:25 flight", stop);
assert.equal(deferred.length, 1);
assert.equal(deferred[0].input.origin.messageId, "SM123", "the realtime goal keeps the Twilio message id");
assert.equal(deferred[0].input.text, objective);
assert.equal(deferred[0].title, "book the 11:25 flight");
assert.equal(deferred[0].opts.intakeReply, reply, "the thread records the SMS that the owner gets");
assert.match(reply, /background task/);
assert.match(reply, /9 minutes/);
assert.doesNotMatch(reply, /hit an error/);

const noBroker = await continueStoppedSmsTurn(undefined, origin, "book the 11:25 flight", stop);
assert.match(noBroker, /stopped working on that after 9 minutes without finishing/);
assert.match(noBroker, /Text me again/);

const failing = { defer: async () => { throw new Error("store down"); } };
const failed = await continueStoppedSmsTurn(failing, origin, "book the 11:25 flight", stop);
assert.equal(failed, noBroker, "a failed defer falls back to the plain stop SMS");

console.log("test-sms-turn-deadline — all passed");
