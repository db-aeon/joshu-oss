#!/usr/bin/env npx tsx
/**
 * Unit tests: coordination scope (mail phase 1) + cross-board mutex contract.
 *
 * Usage: npm run test:coordination-scope
 */
import assert from "node:assert/strict";
import {
  assertSpawnAllowed,
  deriveScopeId,
  mergeScopes,
  resolveMailCoordinationScope,
  taskBodyMatchesScope,
  findOpenMeetingByScope,
} from "../src/coordination/index.js";
import { isOwnerDirectAgentAsk } from "../src/ea/ownerReplyEligibility.js";

// Meo-style cross-provider facets → same scopeId when RFC matches.
{
  const nylasScope = {
    scopeId: "",
    channel: "mail",
    facets: [
      {
        channel: "mail",
        key: "0cfcfa2f-nylas-thread",
        provider: "nylas",
        rfcMessageId: "abc123@gmail.com",
      },
    ],
    participants: ["dan@example.com", "michael@buildmomentum.dev"],
    topic: "checking in on joshu",
    threadIds: ["0cfcfa2f-nylas-thread"],
    sourcePaths: ["connectors/mail/nylas/threads/0cfcfa2f.md"],
    rfcMessageId: "abc123@gmail.com",
  };
  nylasScope.scopeId = deriveScopeId({
    facets: nylasScope.facets,
    participants: nylasScope.participants,
    topic: nylasScope.topic,
    rfcMessageId: nylasScope.rfcMessageId,
  });

  const gmailScope = {
    scopeId: "",
    channel: "mail",
    facets: [
      {
        channel: "mail",
        key: "19ffc6a5-gmail-thread",
        provider: "gmail",
        rfcMessageId: "abc123@gmail.com",
      },
    ],
    participants: ["dan@example.com", "michael@buildmomentum.dev"],
    topic: "checking in on joshu",
    threadIds: ["19ffc6a5-gmail-thread"],
    sourcePaths: ["connectors/mail/gmail/work/threads/19ffc6a5.md"],
    rfcMessageId: "abc123@gmail.com",
  };
  gmailScope.scopeId = deriveScopeId({
    facets: gmailScope.facets,
    participants: gmailScope.participants,
    topic: gmailScope.topic,
    rfcMessageId: gmailScope.rfcMessageId,
  });

  assert.equal(nylasScope.scopeId, gmailScope.scopeId, "RFC-linked aliases share scopeId");

  const merged = mergeScopes(nylasScope, gmailScope);
  assert.equal(merged.scopeId, nylasScope.scopeId);
  assert.equal(merged.threadIds.length, 2);
}

// Mutex: open scheduling blocks owner-reply spawn.
{
  const scope = {
    scopeId: "test-scope-mutex",
    channel: "mail",
    facets: [{ channel: "mail", key: "thread-1" }],
    participants: [],
    threadIds: ["thread-1"],
    sourcePaths: [],
  };
  const active = [
    {
      scopeId: scope.scopeId,
      capability: "meeting_negotiation",
      board: "ea-scheduling",
      task_id: "t_sched",
      channel: "mail",
      created_at: new Date().toISOString(),
    },
  ];
  const gate = assertSpawnAllowed({
    scope,
    requestingBoard: "ea-owner-reply",
    capability: "owner_deliverable",
    active,
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.conflict.reason, "existing_scheduling");
    assert.equal(gate.conflict.task_id, "t_sched");
  }
}

// Mutex: open owner-reply blocks scheduling spawn.
{
  const scope = {
    scopeId: "test-scope-mutex-2",
    channel: "mail",
    facets: [{ channel: "mail", key: "thread-2" }],
    participants: [],
    threadIds: ["thread-2"],
    sourcePaths: [],
  };
  const active = [
    {
      scopeId: scope.scopeId,
      capability: "owner_deliverable",
      board: "ea-owner-reply",
      task_id: "t_or",
      channel: "mail",
      created_at: new Date().toISOString(),
    },
  ];
  const gate = assertSpawnAllowed({
    scope,
    requestingBoard: "ea-scheduling",
    capability: "meeting_negotiation",
    active,
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.conflict.reason, "existing_owner_reply");
  }
}

// Task body matches any alias in scope.
{
  const scope = {
    scopeId: "body-match",
    channel: "mail",
    facets: [],
    participants: [],
    threadIds: ["nylas-id", "gmail-id"],
    sourcePaths: ["connectors/mail/nylas/threads/nylas-id.md"],
  };
  const body =
    "kind: meeting\nthread_id: gmail-id\nsource_paths:\n  - connectors/mail/gmail/work/threads/gmail-id.md";
  assert.equal(taskBodyMatchesScope(body, scope), true);
  const hit = findOpenMeetingByScope(
    [{ task_id: "t1", body }],
    scope,
  );
  assert.equal(hit?.task_id, "t1");
}

// Path A vs path D: counterparty thread is not a direct agent ask.
{
  process.env.JOSHU_AROZ_USER = "dan@example.com";
  const counterparty = isOwnerDirectAgentAsk({
    from: "Dan <dan@example.com>",
    to: ["Michael <michael@buildmomentum.dev>"],
    cc: ["finn@joshu.me"],
    projectRoot: process.cwd(),
    agentEmails: ["finn@joshu.me"],
  });
  assert.equal(counterparty, false);

  const direct = isOwnerDirectAgentAsk({
    from: "Dan <dan@example.com>",
    to: ["finn@joshu.me"],
    projectRoot: process.cwd(),
    agentEmails: ["finn@joshu.me"],
  });
  assert.equal(direct, true);
}

// Phase 2 contract stub: SMS + mail merge when participants + topic align.
{
  const mailScope = {
    scopeId: deriveScopeId({
      facets: [{ channel: "mail", key: "thread-meo" }],
      participants: ["dan@example.com", "michael@buildmomentum.dev"],
      topic: "schedule walkthrough with michael",
    }),
    channel: "mail",
    facets: [{ channel: "mail", key: "thread-meo" }],
    participants: ["dan@example.com", "michael@buildmomentum.dev"],
    topic: "schedule walkthrough with michael",
    threadIds: ["thread-meo"],
    sourcePaths: [],
  };
  const smsScope = {
    scopeId: deriveScopeId({
      facets: [{ channel: "sms", key: "SM123" }],
      participants: ["+15551234567", "michael"],
      topic: "schedule walkthrough with michael",
    }),
    channel: "sms",
    facets: [{ channel: "sms", key: "SM123" }],
    participants: ["+15551234567", "michael"],
    topic: "schedule walkthrough with michael",
    threadIds: [],
    sourcePaths: [],
  };
  const merged = mergeScopes(mailScope, smsScope);
  assert.ok(merged.facets.some((f) => f.channel === "mail"));
  assert.ok(merged.facets.some((f) => f.channel === "sms"));
  assert.ok(merged.participants.length >= 3);
}

// resolveMailCoordinationScope without mirror (minimal input).
{
  const scope = await resolveMailCoordinationScope({
    channel: "mail",
    filesRoot: "/tmp/joshu-coordination-test-nonexistent",
    threadId: "minimal-thread",
    provider: "nylas",
    subject: "Hello",
    from: "dan@example.com",
  });
  assert.equal(scope.threadIds[0], "minimal-thread");
  assert.ok(scope.scopeId.length >= 16);
}

console.log("test:coordination-scope — all assertions passed");
