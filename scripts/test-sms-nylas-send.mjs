#!/usr/bin/env node
/**
 * A text conversation with the owner does not hold email of the companion
 * (spec companion-email-send). The SMS session helpers and the browser handoff
 * continuation on SMS still work.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gateNylasSendRequest } from "../dist/actionGuard/nylasSendGate.js";
import { createHandoff, completeHandoff } from "../dist/browserHandoff/store.js";
import { setSmsTransportForTests } from "../dist/twilioSmsSend.js";
import { isSmsHermesSessionKey } from "../dist/twilioSmsSession.js";
import {
  phoneFromSmsHermesSessionKey,
  shouldDeliverSmsHandoffContinuation,
} from "../dist/browserHandoff/smsContinue.js";

delete process.env.JOSHU_ACTION_GUARD_ENABLED;

const now = Date.now();
const phone = "+15551234567";
const smsSessionKey = `sms:${phone}:${now}`;

/** A project root with an SMS session of the owner that was active `ageMs` ago. */
function projectRoot(ageMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-sms-nylas-"));
  const smsDir = path.join(root, ".joshu", "sms");
  fs.mkdirSync(smsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(smsDir, "sessions.json"),
    JSON.stringify(
      { sessions: { [phone]: { sessionKey: smsSessionKey, lastActiveAt: new Date(now - ageMs).toISOString() } } },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return root;
}

const toOwner = { to: "owner@example.com", subject: "Fwd: About page", body: "Forwarded as you asked." };
const toOther = { to: "guest@example.com", subject: "Re: Meeting", body: "Yes, Tuesday works." };

assert.equal(isSmsHermesSessionKey(smsSessionKey), true);
assert.equal(isSmsHermesSessionKey("joshu-hermes-chat:abc"), false);
assert.equal(phoneFromSmsHermesSessionKey(`sms:${phone}:123`), phone);

// The owner texted 5 minutes ago: email to the owner and to another person goes out.
const texting = projectRoot(5 * 60_000);
assert.deepEqual(await gateNylasSendRequest({ headers: {} }, toOwner, texting), { allowed: true });
assert.deepEqual(await gateNylasSendRequest({ headers: {} }, toOther, texting), { allowed: true });

// A browser handoff that started from a text ended a moment ago: email still goes out.
const handoff = createHandoff(texting, {
  pageUrl: "https://example.com/orders",
  pageTitle: "Your Orders",
  instructions: "Find the most recent order",
  hermesSessionKey: smsSessionKey,
});
completeHandoff(texting, handoff.id);
const completed = JSON.parse(
  fs.readFileSync(path.join(texting, ".joshu", "browser-handoff", `${handoff.id}.json`), "utf8"),
);
assert.equal(shouldDeliverSmsHandoffContinuation(completed), true);
assert.deepEqual(await gateNylasSendRequest({ headers: {} }, toOwner, texting), { allowed: true });

// With the action guard on, the owner gets the same Yes or No question whether or not
// the owner texts. Nobody answers, so the question times out and the email does not go out.
const guardEnv = {
  JOSHU_ACTION_GUARD_ENABLED: "1",
  JOSHU_ACTION_GUARD_TIMEOUT_MS: "300",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "test",
  TWILIO_PHONE_NUMBER: "+15550009999",
  TWILIO_SMS_WEBHOOK_URL: "https://box.test/sms/inbound",
  TWILIO_OWNER_CALLER: "+15550001111",
};
const savedEnv = Object.fromEntries(Object.keys(guardEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, guardEnv);
const questions = [];
setSmsTransportForTests({
  send: async (to, body) => (questions.push({ to, body }), ["SM1"]),
  status: async (sid) => ({ sid, status: "delivered" }),
  sleep: async () => {},
});
try {
  const quiet = projectRoot(3 * 60 * 60_000);
  for (const root of [texting, quiet]) {
    const before = questions.length;
    const gate = await gateNylasSendRequest({ headers: {} }, toOther, root);
    assert.equal(gate.allowed, false, "the email waits for the owner");
    assert.ok("stub" in gate, "a timeout of the action guard returns a stub, not an error");
    assert.equal(questions.length - before, 1, "the owner gets one Yes or No question");
  }
} finally {
  setSmsTransportForTests();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("sms-nylas-send: ok");
