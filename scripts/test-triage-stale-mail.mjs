#!/usr/bin/env npx tsx
/**
 * Unit tests: no triage stub for stale mail
 * (spec mail-triage, OpenSpec change triage-skip-stale-mail).
 * The tests write to a temporary files root and make no LLM call.
 *
 * Usage: npm run test:triage-stale-mail
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isStaleForScheduling } from "../src/ea/ingestFilters.js";
import { createTriageStubAfterMirror } from "../src/ea/triageStub.js";

const HOUR_MS = 60 * 60 * 1000;
const isoHoursAgo = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();

function tempRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "triage-stale-"));
  const filesRoot = path.join(base, "files");
  const projectRoot = path.join(base, "app");
  fs.mkdirSync(filesRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  return { filesRoot, projectRoot };
}

function stubs(filesRoot) {
  try {
    return fs.readdirSync(path.join(filesRoot, "Triage")).filter((name) => name.endsWith(".stub.md"));
  } catch {
    return [];
  }
}

function gmailInput(roots, overrides) {
  return {
    ...roots,
    provider: "gmail",
    accountKey: "owner_at_example_com",
    threadId: "19a0c0ffee000001",
    sourcePath: "connectors/mail/gmail/owner_at_example_com/threads/19a0c0ffee000001.md",
    subject: "Invoice for March",
    from: "Billing <billing@vendor.example>",
    labels: ["INBOX"],
    messageId: "19a0c0ffee000001",
    ...overrides,
  };
}

delete process.env.JOSHU_EA_SCHEDULING_MAX_AGE_HOURS;
delete process.env.JOSHU_EA_SCHEDULING_MAX_AGE_MS;

// Age limit: same as isStaleForScheduling (default 36 hours).
assert.equal(isStaleForScheduling(isoHoursAgo(37)), true);
assert.equal(isStaleForScheduling(isoHoursAgo(35)), false);
assert.equal(isStaleForScheduling(undefined), false);

// Scenario "A catch-up mirrors months-old mail": the classifier would run (new latest message).
{
  const roots = tempRoots();
  await createTriageStubAfterMirror(gmailInput(roots, { receivedAt: "2026-01-14T09:30:00.000Z" }));
  assert.deepEqual(stubs(roots.filesRoot), [], "stale mail with a new latest message gets no stub");
}

// Scenario "Old mail is relabeled": the latest message did not change, so no classifier call.
{
  const roots = tempRoots();
  await createTriageStubAfterMirror(
    gmailInput(roots, {
      receivedAt: isoHoursAgo(24 * 90),
      priorLatestMessageId: "19a0c0ffee000001",
    }),
  );
  assert.deepEqual(stubs(roots.filesRoot), [], "relabeled stale mail gets no stub");
}

// Scenario "Stale mail in the companion inbox" (Nylas, no account key).
{
  const roots = tempRoots();
  await createTriageStubAfterMirror({
    ...gmailInput(roots, { receivedAt: isoHoursAgo(72), classify: false }),
    provider: "nylas",
    accountKey: undefined,
    labels: [],
  });
  assert.deepEqual(stubs(roots.filesRoot), [], "stale Nylas mail gets no stub");
}

// Scenario "Recent mail still gets a stub" (classifier off, so the plain stub path runs).
{
  const roots = tempRoots();
  await createTriageStubAfterMirror(gmailInput(roots, { receivedAt: isoHoursAgo(2), classify: false }));
  assert.deepEqual(stubs(roots.filesRoot), ["gmail-owner_at_example_com-19a0c0ffee000001.stub.md"]);
  const raw = fs.readFileSync(
    path.join(roots.filesRoot, "Triage", "gmail-owner_at_example_com-19a0c0ffee000001.stub.md"),
    "utf8",
  );
  assert.match(raw, /^state: new$/m);
}

// Scenario "No date on the newest message": not stale, so the stub is written as before.
{
  const roots = tempRoots();
  await createTriageStubAfterMirror(gmailInput(roots, { receivedAt: undefined, classify: false }));
  assert.equal(stubs(roots.filesRoot).length, 1, "mail with no date gets a stub");
}

// Scenario "The age limit is changed": JOSHU_EA_SCHEDULING_MAX_AGE_HOURS also moves the stub limit.
{
  process.env.JOSHU_EA_SCHEDULING_MAX_AGE_HOURS = String(24 * 365 * 10);
  try {
    const roots = tempRoots();
    await createTriageStubAfterMirror(
      gmailInput(roots, { receivedAt: "2026-01-14T09:30:00.000Z", classify: false }),
    );
    assert.equal(stubs(roots.filesRoot).length, 1, "mail inside a larger age limit gets a stub");
  } finally {
    delete process.env.JOSHU_EA_SCHEDULING_MAX_AGE_HOURS;
  }
}

console.log("test-triage-stale-mail: ok");
