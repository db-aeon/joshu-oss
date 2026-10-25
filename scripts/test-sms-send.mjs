#!/usr/bin/env npx tsx
/**
 * Unit tests: SMS GSM folding + action-guard approval reply parsing.
 *
 * Usage: npm run test:sms-send
 */
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseApprovalReply } from "../src/actionGuard/approvalReply.js";
import { listOpenPending } from "../src/actionGuard/pending.js";
import { handleSmsApprovalIngress } from "../src/actionGuard/smsIngress.js";
import { SMS_MAX_CHARS, SMS_MAX_PARTS, smsGsmFold, smsGsmParts, smsGsmPlaintext } from "../src/twilioSmsSend.js";
import {
  HermesStreamContentScrubber,
  looksLikeLeakedModelOutput,
  scrubHermesAssistantContent,
} from "../src/hermesStreamContentScrubber.js";
import { smsModelReplyPlaintext } from "../src/smsModelReplyPlaintext.js";

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
  const folded = smsGsmFold("LAX\u2194SFO 7:16 AM \u2192 SFO\nBack line");
  assert.match(folded, /LAX-SFO 7:16 AM to SFO/);
  assert.match(folded, /Back line/);
  assert.equal(/[^\x09\x0A\x0D\x20-\x7E]/.test(folded), false);
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

{
  const leaked =
    "Owner said no. Closing the card. Let me reconcile the rest. I need to pass the arguments. " +
    "<DSMLtool_calls> <DSMLinvoke name=\"tool_call\"> " +
    "<DSMLparameter name=\"name\" string=\"true\">mcp__joshu_connectors__mail_list_track_tasks</DSMLparameter>";
  assert.equal(scrubHermesAssistantContent(leaked).includes("DSML"), false);
  assert.equal(looksLikeLeakedModelOutput(leaked), true);
  // SMS plaintext is markdown-only — DSML scrub is Hermes's job at source.
  assert.match(smsModelReplyPlaintext(leaked), /Owner said no/);
}

{
  const ok = smsModelReplyPlaintext("Got it — I'll close the ByteDance thread and leave you alone on that one.");
  assert.match(ok, /close the ByteDance thread/);
}

{
  const handoff =
    "Tap here to sign in: https://example.box.joshu.me/joshu/handoff/abc?t=token&exp=123";
  assert.match(smsModelReplyPlaintext(handoff), /example\.box\.joshu\.me\/joshu\/handoff\/abc/);
}

// SMS replies keep line breaks and list items (issue #74).
{
  const reply =
    "**You have 3 new DMs:**\n\n* Axel (Orchid) - 3h. Booked\n* Maya - 5h. See you Friday\n+ Sam - 1d. Thanks!\n\nWant me to reply to any?";
  const plain = smsModelReplyPlaintext(reply);
  assert.equal(
    plain,
    "You have 3 new DMs:\n\n- Axel (Orchid) - 3h. Booked\n- Maya - 5h. See you Friday\n- Sam - 1d. Thanks!\n\nWant me to reply to any?",
  );
}

{
  const plain = smsModelReplyPlaintext("Your RSVP is approved.\n\nThe event page shows the address.");
  assert.doesNotMatch(plain, /\.\./);
  assert.equal(plain, "Your RSVP is approved.\n\nThe event page shows the address.");
}

{
  const plain = smsModelReplyPlaintext(
    "## Partiful\n> Open [the event page](https://partiful.com/e/abc) or [https://x.com](https://x.com).\n---\nCode: `ABC123` and *soon*.\n```\nCONF 9921\n```",
  );
  assert.match(plain, /^Partiful$/m);
  assert.match(plain, /the event page: https:\/\/partiful\.com\/e\/abc/);
  assert.match(plain, /or https:\/\/x\.com\./);
  assert.doesNotMatch(plain, /[#>`*]|---/);
  assert.match(plain, /Code: ABC123 and soon\./);
  assert.match(plain, /CONF 9921/);
}

{
  // A removed emoji leaves one space.
  assert.equal(smsGsmFold('Reacted \u{1F44D} to "Booked"'), 'Reacted to "Booked"');
}

{
  // A long list splits at line breaks, so no list item is cut across two SMS parts.
  const items = Array.from({ length: 9 }, (_, i) => `${i + 1}. ${"x".repeat(95)}`);
  const parts = smsGsmParts(items.join("\n"));
  assert.ok(parts.length >= 2);
  for (const part of parts) {
    for (const line of part.split("\n")) assert.ok(items.includes(line), `whole list item: ${line.slice(0, 20)}`);
  }
}

{
  const scrubber = new HermesStreamContentScrubber();
  const parts = [
    "Sure — ",
    "<DSMLtool_calls> <DSMLinvoke ",
    'name="tool_call"> junk',
  ];
  let out = "";
  for (const p of parts) out += scrubber.feed(p);
  out += scrubber.flush();
  assert.equal(out.includes("DSML"), false);
  assert.match(out, /Sure/);
}

{
  const scrubber = new HermesStreamContentScrubber();
  const full =
    "Hey. Quiet Sunday morning over here.\n\nHow's it actually going — rested, or already working?";
  let streamed = "";
  for (const ch of full) streamed += scrubber.feed(ch);
  assert.ok(streamed.length < full.length, "hold-back must retain a tail mid-stream");
  assert.equal(streamed.endsWith("working?"), false);
  streamed += scrubber.flush();
  assert.equal(streamed, full);
}

function pendingDirForRoot(root) {
  const arozUser = "test@example.com";
  return path.join(root, ".local", "arozos-data", "files", "users", arozUser, ".joshu", "action-guard", "pending");
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-sms-ingress-"));
  process.env.JOSHU_AROZ_USER = "test@example.com";
  process.env.AROZ_DATA = path.join(root, ".local", "arozos-data");
  const pendingDir = pendingDirForRoot(root);
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir, "stale.json"),
    JSON.stringify(
      {
        id: "stale",
        actionId: "nylas_send_message",
        summary: { to: "old@example.com" },
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:30:00.000Z",
        status: "pending",
      },
      null,
      2,
    ),
  );
  assert.equal(listOpenPending(root).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pendingDir, "stale.json"), "utf8")).status, "timeout");
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-sms-ingress-off-"));
  process.env.JOSHU_AROZ_USER = "test@example.com";
  process.env.AROZ_DATA = path.join(root, ".local", "arozos-data");
  const policyDir = path.join(root, ".local", "arozos-data", "files", "users", "test@example.com", ".joshu", "action-guard");
  fs.mkdirSync(path.join(policyDir, "pending"), { recursive: true });
  fs.writeFileSync(
    path.join(policyDir, "policy.json"),
    JSON.stringify({ enabled: false }, null, 2),
  );
  const consumed = await handleSmsApprovalIngress("+15551234567", "ok", root);
  assert.equal(consumed, false);
}

console.log("test-sms-send: ok");
