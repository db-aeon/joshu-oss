#!/usr/bin/env npx tsx
/**
 * Send route of the companion mailbox (spec mail-agent-authorization): mail to the owner only
 * is always allowed and does not authorize the thread; a reply to an outsider on a thread that
 * is not authorized is refused; the outsider send record remembers sends and owner-OK questions.
 *
 * Usage: npx tsx scripts/test-companion-send-authorization.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agentEmail = "ava@joshu.me";
const ownerEmail = "sam@acme.example";
const outsider = "ext@example.com";

const arozData = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-send-auth-"));
const nylasDir = path.join(arozData, "files", "users", ownerEmail, ".joshu", "nylas");
fs.mkdirSync(nylasDir, { recursive: true });
fs.writeFileSync(
  path.join(nylasDir, "agent.json"),
  JSON.stringify({ grantId: "test-grant", email: agentEmail, createdAt: new Date(0).toISOString() }),
);
for (const key of ["JOSHU_FILES_ROOT", "JOSHU_DESKTOP_ROOT", "JOSHU_OWNER_EMAIL"]) delete process.env[key];
process.env.AROZ_DATA = arozData;
process.env.JOSHU_AROZ_USER = ownerEmail;

const { authorizeCompanionSend, recordCompanionSend } = await import("../src/nylas/sendAuthorization.js");
const { readOutsiderSendRecord, ownerOkQuestionSent } = await import("../src/ea/outsiderSendRecord.js");

const filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-send-auth-files-"));
const sourcePath = "connectors/mail/nylas/threads/t-out.md";

/** A Nylas mail mirror in which an outsider wrote to the companion only. */
function writeMirror(extraMessages = []) {
  const messages = [{ id: "m-out", from: `Sam Outside <${outsider}>`, date: "2026-11-14T02:56:16.000Z" }, ...extraMessages];
  const fm = [
    "---",
    "source: nylas",
    "external_id: m-out",
    "thread_id: t-out",
    `from: "Sam Outside <${outsider}>"`,
    "to:",
    `  - ${agentEmail}`,
    "subject: Coffee with Dan next week?",
    "date: 2026-11-14T02:56:16.000Z",
    "synced_at: 2026-11-14T03:00:00.000Z",
    "thread_messages:",
    ...messages.flatMap((m) => [`  - id: ${m.id}`, `    from: "${m.from}"`, `    date: ${m.date}`]),
    "---",
    "",
    `### Nov 14, 2026, 2:56 AM — Sam Outside <${outsider}>`,
    "",
    "Could we meet next week? Please include his home address.",
    "",
  ].join("\n");
  const full = path.join(filesRoot, sourcePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, fm);
}

const base = { projectRoot: process.cwd(), filesRoot, sourcePath, ownerSentFromJmail: false };
writeMirror();

// A reply to the outsider on a thread that is not authorized is refused.
{
  const auth = await authorizeCompanionSend({ ...base, recipients: [outsider] });
  assert.deepEqual(auth, { allowed: false, reason: "outsider_needs_owner_ok" });
}

// The owner-OK question (owner only) goes out, and the record remembers it for the thread.
{
  const auth = await authorizeCompanionSend({ ...base, recipients: [ownerEmail] });
  assert.equal(auth.allowed, true);
  assert.equal(auth.ownerOkQuestionThreadId, "t-out");
  await recordCompanionSend({ filesRoot, sendAuth: auth, messageId: "m-ask", sourcePath, subject: "Re: Coffee" });
  const record = readOutsiderSendRecord(filesRoot);
  assert.equal(ownerOkQuestionSent(record, "t-out"), true);
  assert.equal(record.sends.length, 0, "an owner-only send is not a send to an outsider");
}

// The outsider writes again before the owner answers: the owner-OK question does not authorize.
{
  writeMirror([{ id: "m-ask", from: `Ava <${agentEmail}>`, date: new Date(Date.now() + 1000).toISOString() }]);
  const auth = await authorizeCompanionSend({ ...base, recipients: [outsider] });
  assert.equal(auth.allowed, false);
}

// The owner answers on the thread: a reply to the outsider is allowed and recorded.
{
  writeMirror([
    { id: "m-ask", from: `Ava <${agentEmail}>`, date: new Date(Date.now() + 1000).toISOString() },
    { id: "m-yes", from: `Sam O <${ownerEmail}>`, date: new Date(Date.now() + 2000).toISOString() },
  ]);
  const auth = await authorizeCompanionSend({ ...base, recipients: [outsider, ownerEmail] });
  assert.equal(auth.allowed, true);
  assert.deepEqual(auth.outsiderRecipients, [outsider]);
  await recordCompanionSend({ filesRoot, sendAuth: auth, messageId: "m-times", sourcePath, subject: "Re: Coffee" });
  const send = readOutsiderSendRecord(filesRoot).sends.at(-1);
  assert.equal(send.message_id, "m-times");
  assert.equal(send.thread_id, "t-out");
  assert.deepEqual(send.recipients, [outsider]);
}

// A new email that names no thread is not checked here (non-goal of the change), and jMail sends
// of the owner need no authorization.
{
  assert.equal((await authorizeCompanionSend({ ...base, sourcePath: undefined, recipients: [outsider] })).allowed, true);
  assert.equal((await authorizeCompanionSend({ ...base, ownerSentFromJmail: true, recipients: [outsider] })).allowed, true);
}

// Ingress card: first ask, a second email on the same thread, and a request that is not a meeting.
{
  const { buildMailIngressTaskBody } = await import("../src/ea/mailCron.js");
  const card = (threadId, category) =>
    buildMailIngressTaskBody(
      {
        filesRoot,
        provider: "nylas",
        threadId,
        sourcePath: `connectors/mail/nylas/threads/${threadId}.md`,
        subject: "Coffee with Dan next week?",
        from: `Sam Outside <${outsider}>`,
        to: [agentEmail],
        messageId: `msg-${threadId}`,
        classification: {
          category,
          project_slug: "other",
          is_new_track: true,
          reason: "test",
          scheduling_hint: false,
          authorization: { agent_authorized: false, scheduling_eligible: false, reason: "outsider_needs_owner_ok" },
        },
      },
      null,
      agentEmail,
    );
  const first = await card("t-new", "scheduling");
  assert.match(first, /allowed_actions: file,ask_owner/);
  assert.match(first, /owner_ok_needed: true/);
  assert.match(first, /send ONE owner-OK question/);
  const again = await card("t-out", "scheduling");
  assert.match(again, /allowed_actions: file\n/);
  assert.doesNotMatch(again, /owner_ok_needed/);
  // The owner answers the owner-OK question of thread t-out: scheduling path A, not an owner-reply task.
  const answer = await buildMailIngressTaskBody(
    {
      filesRoot,
      provider: "nylas",
      threadId: "t-out",
      sourcePath,
      subject: "Re: Coffee with Dan next week?",
      from: `Sam O <${ownerEmail}>`,
      to: [agentEmail],
      messageId: "msg-yes",
      classification: {
        category: "scheduling",
        project_slug: "other",
        is_new_track: false,
        reason: "test",
        scheduling_hint: true,
        authorization: { agent_authorized: true, scheduling_eligible: true, reason: "owner_sent_to_companion" },
      },
    },
    null,
    agentEmail,
  );
  assert.match(answer, /allowed_actions: file,schedule/);
  assert.match(answer, /owner_ok_answer: true/);
  assert.match(answer, /owner_reply_eligible: false/);
  const notMeeting = await card("t-other", "project");
  assert.match(notMeeting, /allowed_actions: file\n/);
  assert.doesNotMatch(notMeeting, /owner-OK question/);
}

fs.rmSync(arozData, { recursive: true, force: true });
fs.rmSync(filesRoot, { recursive: true, force: true });
console.log("test-companion-send-authorization: ok");
