#!/usr/bin/env npx tsx
/**
 * Unit tests for mail agent authorization (copied / delegated gate).
 *
 * Usage: npx tsx scripts/test-agent-authorization.mjs
 */
import assert from "node:assert/strict";
import { resolveAgentAuthorization } from "../src/ea/agentAuthorization.js";

const agentEmail = "patrick@joshu.me";
const ownerEmail = "db@project-aeon.com";

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

// Patch agent emails via env for deterministic tests
process.env.JOSHU_AGENT_EMAILS = agentEmail;
process.env.JOSHU_AROZ_USER = ownerEmail;

// Not copied — scheduling-shaped mail must not act
{
  const auth = resolveAgentAuthorization(baseInput());
  assert.equal(auth.agent_authorized, false);
  assert.equal(auth.scheduling_eligible, false);
  assert.equal(auth.reason, "not_copied_or_delegated");
}

// Agent on CC — authorized + scheduling eligible
{
  const auth = resolveAgentAuthorization(
    baseInput({ cc: [agentEmail], category: "scheduling" }),
  );
  assert.equal(auth.agent_authorized, true);
  assert.equal(auth.scheduling_eligible, true);
  assert.equal(auth.reason, "agent_on_recipients");
}

// Agent on CC but non-scheduling category — authorized, not scheduling
{
  const auth = resolveAgentAuthorization(
    baseInput({ cc: [agentEmail], category: "project" }),
  );
  assert.equal(auth.agent_authorized, true);
  assert.equal(auth.scheduling_eligible, false);
}

// Owner delegates in trigger body
{
  const auth = resolveAgentAuthorization(
    baseInput({
      from: `Dan B <${ownerEmail}>`,
      triggerBodyPreview: "Copying Patrick to suggest some times.",
      threadBodyPreview: "Copying Patrick to suggest some times.",
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
    baseInput({ from: `Patrick <${agentEmail}>` }),
  );
  assert.equal(auth.agent_authorized, false);
  assert.equal(auth.reason, "agent_sent_message");
}

// Outbound follow-up: skipAgentSentGuard + owner delegation in thread body
{
  const auth = resolveAgentAuthorization(
    baseInput({
      from: `Patrick <${agentEmail}>`,
      to: ["mcarneiro@google.com"],
      cc: ["dbenyamin@gmail.com"],
      skipAgentSentGuard: true,
      triggerBodyPreview: "I am copying Patrick to share some availability.",
      threadBodyPreview: [
        `### 2026-07-14T19:42:10.000Z — Dan Benyamin <${ownerEmail}>`,
        "",
        "**Subject:** Fwd: intro",
        "",
        "I am copying Patrick to share some availability.",
        "",
        "---",
        "",
        `### 2026-07-14T20:02:53.000Z — Patrick <${agentEmail}>`,
        "",
        "Here are some windows…",
      ].join("\n"),
      category: "scheduling",
    }),
  );
  assert.equal(auth.agent_authorized, true);
  assert.equal(auth.reason, "owner_delegated_thread");
}

console.log("test-agent-authorization: ok");
