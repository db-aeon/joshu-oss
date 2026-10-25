#!/usr/bin/env npx tsx
/**
 * Unit tests: block kind after an action-guard outcome
 * (OpenSpec change proactive-clarify-hardening, spec owner-nudge,
 * requirement "Blocks on the owner set block kind needs_input").
 *
 * Usage: npm run test:scheduling-send-followup
 */
import assert from "node:assert/strict";

import { buildReasonAndComment } from "../src/ea/schedulingSendFollowup.js";

const body = { to: [{ email: "dana@example.com" }], subject: "Re: Intro" };

// Scenario "Owner denies a send".
{
  const out = buildReasonAndComment({ kind: "denied" }, body);
  assert.equal(out.blockKind, "needs_input");
  assert.match(out.reason, /^owner denied send/);
}

// Scenario "Approval times out".
{
  const out = buildReasonAndComment({ kind: "timeout" }, body);
  assert.equal(out.blockKind, "needs_input");
  assert.match(out.reason, /^approval timed out/);
}

// The email was delivered: the task waits on the counterparty, not on the owner.
{
  const out = buildReasonAndComment({ kind: "delivered", messageId: "m1" }, body);
  assert.equal(out.blockKind, null);
  assert.match(out.reason, /^awaiting reply:/);
}

// The owner channel failed: not an owner question.
{
  const out = buildReasonAndComment({ kind: "unavailable", code: "503" }, body);
  assert.equal(out.blockKind, null);
  assert.match(out.reason, /^action-guard-unavailable:/);
}

console.log("test-scheduling-send-followup: ok");
