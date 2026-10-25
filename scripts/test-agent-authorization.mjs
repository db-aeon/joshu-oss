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
