#!/usr/bin/env npx tsx
/**
 * Unit tests: SMS GSM folding + action-guard approval reply parsing.
 *
 * Usage: npm run test:sms-send
 */
import assert from "node:assert/strict";

import { parseApprovalReply } from "../src/actionGuard/approvalReply.js";
import { SMS_MAX_CHARS, SMS_MAX_PARTS, smsGsmParts, smsGsmPlaintext } from "../src/twilioSmsSend.js";

{
  assert.equal(parseApprovalReply("y"), "approved");
  assert.equal(parseApprovalReply("yes"), "approved");
  assert.equal(parseApprovalReply("ok"), "approved");
  assert.equal(parseApprovalReply("ok thanks"), "approved");
  assert.equal(parseApprovalReply("n"), "denied");
  assert.equal(parseApprovalReply("no"), "denied");
}

{
  assert.equal(parseApprovalReply("Ok on Nevada. Before I blocked it I was unable to log in."), null);
  assert.equal(parseApprovalReply("Yes I want to book the Tuesday slot with Maria"), null);
  assert.equal(parseApprovalReply("See last text"), null);
}

{
  const folded = smsGsmPlaintext("I've got your text — the one about Conduit…");
  assert.match(folded, /I've got your text - the one about Conduit.../);
  assert.equal(/[^\x09\x0A\x0D\x20-\x7E]/.test(folded), false);
}

{
  const long = `${"A".repeat(SMS_MAX_CHARS + 80)} leftover`;
  const parts = smsGsmParts(long);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= SMS_MAX_CHARS);
  assert.ok(parts.join("").includes("A"));
  assert.ok(parts.some((p) => p.includes("leftover")));
}

{
  const sentences = Array.from({ length: 40 }, (_, i) => `Sentence ${i} has more detail.`).join(" ");
  const parts = smsGsmParts(sentences);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.length <= SMS_MAX_CHARS);
    assert.equal(/[^\x09\x0A\x0D\x20-\x7E]/.test(p), false);
  }
  assert.ok(parts.length <= SMS_MAX_PARTS);
}

{
  const one = smsGsmPlaintext("I've got your text — short.");
  assert.ok(one.length < SMS_MAX_CHARS);
}

console.log("test-sms-send: ok");
