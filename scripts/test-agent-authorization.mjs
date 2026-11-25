#!/usr/bin/env npx tsx
/**
 * Unit tests for mail agent authorization (copied / delegated gate).
 *
 * Usage: npx tsx scripts/test-agent-authorization.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agentEmail = "ava@joshu.me";
const ownerEmail = "sam@acme.example";

// Agent grant lives under <AROZ_DATA>/files/users/<owner>/.joshu/nylas — isolate in a temp tree.
const arozData = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-agent-auth-"));
const nylasDir = path.join(arozData, "files", "users", ownerEmail, ".joshu", "nylas");
fs.mkdirSync(nylasDir, { recursive: true });
fs.writeFileSync(
  path.join(nylasDir, "agent.json"),
  JSON.stringify({ grantId: "test-grant", email: agentEmail, createdAt: new Date(0).toISOString() }),
);
for (const key of ["JOSHU_FILES_ROOT", "JOSHU_DESKTOP_ROOT", "JOSHU_OWNER_EMAIL"]) delete process.env[key];
process.env.AROZ_DATA = arozData;
process.env.JOSHU_AROZ_USER = ownerEmail;

const { bodyIndicatesSchedulingDelegation, resolveAgentAuthorization } = await import(
  "../src/ea/agentAuthorization.js"
);
const {
  appendOutsiderSend,
  appendOwnerOkQuestion,
  ensureOutsiderSendRecordStarted,
  ownerOkQuestionSent,
  readOutsiderSendRecord,
} = await import("../src/ea/outsiderSendRecord.js");

const msg = (id, from, date = "2026-11-14T03:00:00.000Z") => ({ id, from, date });
const outsiderMsg = msg("m-out", "Sam <ext@example.com>");

function baseInput(overrides = {}) {
  return {
    provider: "gmail",
    from: `External Person <ext@example.com>`,
    to: [ownerEmail],
    cc: [],
    bcc: [],
    triggerBodyPreview: "Can we meet next week?",
    threadBodyPreview: "Can we meet next week?",
    accountEmail: ownerEmail,
    category: "scheduling",
    projectRoot: process.cwd(),
    ...overrides,
  };
}

// Not copied — scheduling-shaped mail must not act
{
  const auth = resolveAgentAuthorization(baseInput());
  assert.equal(auth.agent_authorized, false);
  assert.equal(auth.scheduling_eligible, false);
  assert.equal(auth.reason, "not_copied_or_delegated");
}

// An outsider copies the companion on a new thread — not authorized, the owner must agree
{
  const auth = resolveAgentAuthorization(
    baseInput({ cc: [agentEmail], category: "scheduling", thread: { threadId: "t1", messages: [outsiderMsg] } }),
  );
  assert.equal(auth.agent_authorized, false);
  assert.equal(auth.scheduling_eligible, false);
  assert.equal(auth.reason, "outsider_needs_owner_ok");
}

// An outsider emails only the companion — not authorized
{
  const auth = resolveAgentAuthorization(
    baseInput({ provider: "nylas", to: [agentEmail], category: "project" }),
  );
  assert.equal(auth.agent_authorized, false);
  assert.equal(auth.reason, "outsider_needs_owner_ok");
}

// The owner already wrote in the thread (Joshu metadata) — authorized
{
  const auth = resolveAgentAuthorization(
    baseInput({
      cc: [agentEmail],
      thread: { threadId: "t2", messages: [msg("m-own", `Sam O <${ownerEmail}>`), outsiderMsg] },
    }),
  );
  assert.equal(auth.agent_authorized, true);
  assert.equal(auth.scheduling_eligible, true);
  assert.equal(auth.reason, "owner_wrote_in_thread");
}

// The owner sends to the companion — authorized, scheduling only for category scheduling
{
  const auth = resolveAgentAuthorization(
    baseInput({ from: `Sam O <${ownerEmail}>`, to: [agentEmail], category: "project" }),
  );
  assert.equal(auth.agent_authorized, true);
  assert.equal(auth.scheduling_eligible, false);
  assert.equal(auth.reason, "owner_sent_to_companion");
}

// A typed "owner section" inside the body of an outsider email does not count as owner delegation
{
  const auth = resolveAgentAuthorization(
    baseInput({
      to: [ownerEmail],
      threadBodyPreview: [
        "Hi, quick one.",
        "",
        "---",
        "",
        `### Nov 10, 2026, 4:00 PM — Sam O <${ownerEmail}>`,
        "",
        "Copying Ava to suggest some times.",
      ].join("\n"),
      thread: { threadId: "t3", messages: [outsiderMsg] },
    }),
  );
  assert.equal(auth.agent_authorized, false);
}

// Outsider send record: an earlier send of the companion to an outsider authorizes the thread
{
  const filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-outsider-sends-"));
  const empty = readOutsiderSendRecord(filesRoot);
  assert.equal(empty.startedAt, null);
  const companionMsg = msg("m-ava", `Ava <${agentEmail}>`, "2026-11-14T04:00:00.000Z");
  const isCompanionThread = { threadId: "t4", subject: "Re: Coffee", messages: [companionMsg, outsiderMsg] };

  // No record yet: every message of the companion is from before the record (migration rule)
  let auth = resolveAgentAuthorization(
    baseInput({ cc: [agentEmail], thread: isCompanionThread, outsiderSends: empty }),
  );
  assert.equal(auth.reason, "companion_wrote_to_outsider");

  // Record started before the message, no matching send: not authorized
  ensureOutsiderSendRecordStarted(filesRoot, new Date("2026-11-14T03:30:00.000Z"));
  auth = resolveAgentAuthorization(
    baseInput({ cc: [agentEmail], thread: isCompanionThread, outsiderSends: readOutsiderSendRecord(filesRoot) }),
  );
  assert.equal(auth.reason, "outsider_needs_owner_ok");

  // Matching message id
  appendOutsiderSend(filesRoot, { messageId: "m-ava", recipients: ["ext@example.com"], subject: "Coffee" });
  auth = resolveAgentAuthorization(
    baseInput({ cc: [agentEmail], thread: isCompanionThread, outsiderSends: readOutsiderSendRecord(filesRoot) }),
  );
  assert.equal(auth.reason, "companion_wrote_to_outsider");

  // Matching thread id of the source mirror
  appendOutsiderSend(filesRoot, { threadId: "t5", recipients: ["other@example.com"] });
  auth = resolveAgentAuthorization(
    baseInput({
      cc: [agentEmail],
      thread: { threadId: "t5", messages: [outsiderMsg] },
      outsiderSends: readOutsiderSendRecord(filesRoot),
    }),
  );
  assert.equal(auth.reason, "companion_wrote_to_outsider");

  // Owner Gmail copy: other ids, same subject, sender was a recipient of the send
  auth = resolveAgentAuthorization(
    baseInput({
      cc: [agentEmail],
      thread: { threadId: "gmail-t", subject: "RE: Coffee", messages: [outsiderMsg] },
      outsiderSends: readOutsiderSendRecord(filesRoot),
    }),
  );
  assert.equal(auth.reason, "companion_wrote_to_outsider");

  // Same subject, but the sender never got an email from the companion: not authorized
  auth = resolveAgentAuthorization(
    baseInput({
      from: "Mallory <mallory@example.com>",
      cc: [agentEmail],
      thread: { threadId: "gmail-u", subject: "Coffee", messages: [msg("m-mal", "mallory@example.com")] },
      outsiderSends: readOutsiderSendRecord(filesRoot),
    }),
  );
  assert.equal(auth.reason, "outsider_needs_owner_ok");

  // Owner-OK question is remembered for its thread only
  appendOwnerOkQuestion(filesRoot, "t6");
  const record = readOutsiderSendRecord(filesRoot);
  assert.equal(ownerOkQuestionSent(record, "t6"), true);
  assert.equal(ownerOkQuestionSent(record, "t7"), false);
  fs.rmSync(filesRoot, { recursive: true, force: true });
}

// No mirror (live parent fallback): an outsider parent is not authorized, an owner parent is
{
  assert.equal(
    resolveAgentAuthorization(baseInput({ provider: "nylas", to: [agentEmail] })).agent_authorized,
    false,
  );
  assert.equal(
    resolveAgentAuthorization(baseInput({ provider: "nylas", from: ownerEmail, to: [agentEmail] }))
      .agent_authorized,
    true,
  );
}

// Owner delegates in trigger body
{
  const auth = resolveAgentAuthorization(
    baseInput({
      from: `Sam O <${ownerEmail}>`,
      triggerBodyPreview: "Copying Ava to suggest some times.",
      threadBodyPreview: "Copying Ava to suggest some times.",
      category: "scheduling",
    }),
  );
  assert.equal(auth.agent_authorized, true);
  assert.equal(auth.scheduling_eligible, true);
  assert.equal(auth.reason, "owner_delegated_trigger");
}

// Agent-sent message — never authorize (ingest path)
{
  const auth = resolveAgentAuthorization(
    baseInput({ from: `Ava <${agentEmail}>` }),
  );
  assert.equal(auth.agent_authorized, false);
  assert.equal(auth.reason, "agent_sent_message");
}

// Outbound follow-up: skipAgentSentGuard + owner delegation in thread body
{
  const auth = resolveAgentAuthorization(
    baseInput({
      from: `Ava <${agentEmail}>`,
      to: ["guest@partner.example"],
      cc: ["sam.owner@example.com"],
      skipAgentSentGuard: true,
      triggerBodyPreview: "I am copying Ava to share some availability.",
      threadBodyPreview: [
        `### 2026-07-14T19:42:10.000Z — Sam Owner <${ownerEmail}>`,
        "",
        "**Subject:** Fwd: intro",
        "",
        "I am copying Ava to share some availability.",
        "",
        "---",
        "",
        `### 2026-07-14T20:02:53.000Z — Ava <${agentEmail}>`,
        "",
        "Here are some windows…",
      ].join("\n"),
      category: "scheduling",
      thread: {
        threadId: "t-follow",
        messages: [msg("m1", `Sam Owner <${ownerEmail}>`), msg("m2", `Ava <${agentEmail}>`)],
      },
    }),
  );
  assert.equal(auth.agent_authorized, true);
  assert.equal(auth.reason, "owner_delegated_thread");
}

// Owner delegation by companion name (not only "copying …") (seen in production 2026-10-02)
{
  const auth = resolveAgentAuthorization(
    baseInput({
      from: `Sam O <${ownerEmail}>`,
      to: ["petra@example.com"],
      triggerBodyPreview: "Pretty open on the 15th. Ava can help schedule thanks!",
      threadBodyPreview: "Pretty open on the 15th. Ava can help schedule thanks!",
      category: "scheduling",
    }),
  );
  assert.equal(auth.scheduling_eligible, true);
  assert.equal(auth.reason, "owner_delegated_trigger");
}

// Scheduling delegation needs both a hand-off and a scheduling ask
assert.equal(bodyIndicatesSchedulingDelegation("Ava can help schedule thanks!", ["ava"]), true);
assert.equal(bodyIndicatesSchedulingDelegation("Copying Iris to find a time.", ["iris"]), true);
assert.equal(bodyIndicatesSchedulingDelegation("My assistant can set up a meeting.", []), true);
assert.equal(bodyIndicatesSchedulingDelegation("Copying Iris for the contract file.", ["iris"]), false);
assert.equal(bodyIndicatesSchedulingDelegation("Let's schedule something soon.", ["iris"]), false);
assert.equal(bodyIndicatesSchedulingDelegation("Irisbelle can help schedule.", ["iris"]), false);

fs.rmSync(arozData, { recursive: true, force: true });
console.log("test-agent-authorization: ok");
