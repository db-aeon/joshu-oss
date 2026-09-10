#!/usr/bin/env npx tsx
/**
 * Unit tests for owner mail visibility (auto-CC, thread scan, action-guard SMS).
 *
 * Usage: npm run test:owner-mail-visibility
 */
import assert from "node:assert/strict";
import {
  ensureOwnerCcOnExternalSend,
  isExternalSend,
  ownerVisibleOnThreadMirror,
  resolvePrimaryOwnerEmail,
} from "../src/ea/ownerMailVisibility.js";
import { buildNylasSendSummary } from "../src/actionGuard/gate.js";
import { formatApprovalMessage } from "../src/actionGuard/approvalMessage.js";

const ownerEmail = "db@project-aeon.com";
const agentEmail = "patrick@joshu.me";
const externalEmail = "counterparty@example.com";

process.env.JOSHU_AGENT_EMAILS = agentEmail;
process.env.JOSHU_AROZ_USER = ownerEmail;

// resolvePrimaryOwnerEmail falls back to env
{
  const primary = resolvePrimaryOwnerEmail(process.cwd());
  assert.equal(primary, ownerEmail);
}

// External send without owner in cc → owner appended
{
  const result = ensureOwnerCcOnExternalSend({
    to: [{ email: externalEmail }],
    cc: [{ email: agentEmail }],
    bcc: undefined,
    projectRoot: process.cwd(),
  });
  assert.equal(result.ownerCcAdded, true);
  assert.ok(result.cc?.some((r) => r.email === ownerEmail));
}

// Owner already in to → no duplicate cc
{
  const result = ensureOwnerCcOnExternalSend({
    to: [{ email: ownerEmail }],
    cc: undefined,
    bcc: undefined,
    projectRoot: process.cwd(),
  });
  assert.equal(result.ownerCcAdded, false);
  assert.equal(isExternalSend([{ email: ownerEmail }], undefined, undefined, process.cwd()), false);
}

// Owner-only send → no cc injection
{
  const result = ensureOwnerCcOnExternalSend({
    to: [{ email: ownerEmail }],
    cc: undefined,
    bcc: undefined,
    projectRoot: process.cwd(),
  });
  assert.equal(result.ownerCcAdded, false);
  assert.equal(result.cc, undefined);
}

// ownerVisibleOnThreadMirror: owner in earlier thread_messages.from → true
{
  const fm = {
    from: `External <${externalEmail}>`,
    to: [agentEmail],
    cc: [],
    thread_messages: [{ from: `Owner <${ownerEmail}>`, message_id: "m1" }],
  };
  const vis = ownerVisibleOnThreadMirror(fm, "", process.cwd());
  assert.equal(vis.ownerOnThread, true);
  assert.equal(vis.reason, "owner_on_thread_headers");
}

// Agent-only thread (four8 pattern) → false + context snippet
{
  const body = [
    "--- message ---",
    `From: Dan Partelow <dan@four8.com>`,
    "Subject: Re: Planning",
    "",
    "Can we reschedule to next week? Plus Patrick, see below.",
    "",
    "--- message ---",
    `From: Patrick <${agentEmail}>`,
    "Subject: Re: Planning",
    "",
    "Here are some times.",
  ].join("\n");
  const fm = {
    from: `Patrick <${agentEmail}>`,
    to: [externalEmail, agentEmail],
    cc: [],
    thread_messages: [
      { from: `Dan Partelow <dan@four8.com>`, message_id: "m1" },
      { from: `Patrick <${agentEmail}>`, message_id: "m2" },
    ],
  };
  const vis = ownerVisibleOnThreadMirror(fm, body, process.cwd());
  assert.equal(vis.ownerOnThread, false);
  assert.equal(vis.reason, "owner_not_on_prior_messages");
  assert.ok(vis.threadContextSnippet?.includes("reschedule"));
}

// buildNylasSendSummary passes visibility fields through
{
  const summary = buildNylasSendSummary({
    to: [{ email: externalEmail }],
    subject: "Re: test",
    body: "Hello",
    ownerOnThread: false,
    ownerCcAdded: true,
    threadContextSnippet: "Can we meet?",
  });
  assert.equal(summary.ownerOnThread, false);
  assert.equal(summary.ownerCcAdded, true);
  assert.equal(summary.threadContextSnippet, "Can we meet?");
}

// formatApprovalMessage includes visibility note when ownerOnThread: false
{
  const msg = formatApprovalMessage("nylas_send_message", {
    to: [{ email: externalEmail }],
    cc: [{ email: ownerEmail }],
    subject: "Re: Planning",
    body: "Proposed times below.",
    ownerOnThread: false,
    ownerCcAdded: true,
    threadContextSnippet: "Can we reschedule to next week?",
  });
  assert.match(msg, /You were not on prior messages in this thread/);
  assert.match(msg, /Owner CC added/);
  assert.match(msg, /Context: Can we reschedule to next week/);
  assert.match(msg, /Proposed times below/);
}

console.log("test-owner-mail-visibility: all passed");
