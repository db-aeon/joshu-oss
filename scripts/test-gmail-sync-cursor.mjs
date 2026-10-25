#!/usr/bin/env npx tsx
/**
 * Unit tests: Gmail sync cursor, deleted Gmail threads, and one run of each connector cron job
 * (OpenSpec change gmail-sync-cursor). A fake Composio tool call replaces the Gmail toolkit.
 *
 * Usage: npm run test:gmail-sync-cursor
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arozData = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-gmail-sync-"));
const AROZ_USER = "owner@example.com";
process.env.AROZ_DATA = arozData;
process.env.JOSHU_AROZ_USER = AROZ_USER;
fs.mkdirSync(path.join(arozData, "files", "users", AROZ_USER, "Desktop"), { recursive: true });

const { parseHistoryRecords } = await import("../src/connectors/composio/gmailHistory.js");
const { setGmailToolsExecuteForTests } = await import("../src/connectors/composio/gmail.js");
const { syncGmailAccount } = await import("../src/connectors/composio/sync.js");
const { readConnectorCronJobs, tickConnectorCron, writeConnectorCronJobs } = await import(
  "../src/connectors/scheduler.js"
);
const { gmailSyncStatePath, mailThreadsDir, resolveConnectorPaths } = await import("../src/connectors/paths.js");

const filesRoot = resolveConnectorPaths(process.cwd()).filesRoot;
const account = { connectedAccountId: "ca_test", accountKey: "owner_at_example_com", email: AROZ_USER, enabled: true };
const statePath = gmailSyncStatePath(filesRoot, account.accountKey);
const threadsDir = mailThreadsDir("gmail", filesRoot, account.accountKey);
const NOT_FOUND = '404 {"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}';

const added = (threadId) => ({ messagesAdded: [{ message: { id: `m_${threadId}`, threadId } }] });
const labeled = (threadId) => ({ labelsAdded: [{ message: { id: `m_${threadId}`, threadId }, labelIds: ["TRASH"] }] });
const deleted = (threadId) => ({ messagesDeleted: [{ message: { id: `m_${threadId}`, threadId } }] });

/**
 * Fake Composio tool call. `pages` are the GMAIL_LIST_HISTORY pages, `threads` maps a thread id to
 * its messages or to an error text. Records each call.
 */
function fakeGmail({ pages = [], threads = {}, profile }) {
  const calls = [];
  setGmailToolsExecuteForTests(async (slug, params) => {
    const args = params.arguments;
    calls.push({ slug, args });
    if (slug === "GMAIL_LIST_HISTORY") {
      const index = args.page_token ? Number(args.page_token) : 0;
      const page = pages[index];
      if (typeof page === "string") return { successful: false, error: page };
      return {
        successful: true,
        data: {
          history: page.history.map((h, i) => ({ id: String(Number(args.start_history_id) + i + 1), ...h })),
          historyId: page.historyId,
          ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}),
        },
      };
    }
    if (slug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID") {
      const thread = threads[args.thread_id];
      if (typeof thread === "string") return { successful: false, error: thread };
      return { successful: true, data: { messages: thread ?? [] } };
    }
    if (slug === "GMAIL_GET_PROFILE") {
      if (profile instanceof Error) return { successful: false, error: profile.message };
      return { successful: true, data: { historyId: profile } };
    }
    throw new Error(`unexpected tool ${slug}`);
  });
  return calls;
}

const promoMessage = (threadId) => ({ id: `m_${threadId}`, threadId, labelIds: ["CATEGORY_PROMOTIONS"] });
const fetchedThreads = (calls) =>
  calls.filter((c) => c.slug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID").map((c) => c.args.thread_id);
const profileCalls = (calls) => calls.filter((c) => c.slug === "GMAIL_GET_PROFILE").length;

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
}
const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const syncIncremental = () =>
  syncGmailAccount(process.cwd(), account, { syncMode: "incremental", classifyTriage: false, skipTriageStubs: true });

// Requirement "A deleted Gmail thread is not fetched again".
{
  // Scenario "History has only a deletion for a thread".
  const parsed = parseHistoryRecords({
    data: { history: [{ id: "11", ...deleted("tDel") }, { id: "12", ...added("tNew") }, { id: "13", ...labeled("tLab") }] },
  });
  assert.deepEqual([...parsed.threadIds].sort(), ["tLab", "tNew"]);
  assert.equal(parsed.latestHistoryId, "13");
}

{
  // Scenario "The thread fetch returns 404": the mail mirror is removed and the run passes.
  writeState({ historyId: "100" });
  fs.mkdirSync(threadsDir, { recursive: true });
  const goneMirror = path.join(threadsDir, "tGone.md");
  fs.writeFileSync(goneMirror, "---\nthread_id: tGone\nmessage_ids:\n  - m_tGone\n---\n\nold mail\n");
  const calls = fakeGmail({
    pages: [{ history: [added("tNew"), labeled("tGone"), labeled("tNoMirror"), deleted("tDel")], historyId: "200" }],
    threads: { tNew: [promoMessage("tNew")], tGone: NOT_FOUND, tNoMirror: NOT_FOUND },
  });
  const result = await syncIncremental();
  assert.equal(result.error, undefined);
  assert.deepEqual(fetchedThreads(calls).sort(), ["tGone", "tNew", "tNoMirror"]);
  assert.equal(fs.existsSync(goneMirror), false);
  assert.equal(readState().lastError, undefined);
}

{
  // Scenario "Another thread fetch error": the mail mirror stays.
  writeState({ historyId: "100" });
  const keptMirror = path.join(threadsDir, "tFlaky.md");
  fs.writeFileSync(keptMirror, "---\nthread_id: tFlaky\nmessage_ids:\n  - m_tFlaky\n---\n\nmail\n");
  fakeGmail({
    pages: [{ history: [labeled("tFlaky")], historyId: "210" }],
    threads: { tFlaky: '429 {"error":{"message":"rate limited"}}' },
  });
  await syncIncremental();
  assert.equal(fs.existsSync(keptMirror), true);
}

// Requirement "The Gmail sync cursor moves after the listed threads are processed".
{
  // Scenario "A good run saves the historyId of the history listing": no GMAIL_GET_PROFILE call,
  // so a failing GMAIL_GET_PROFILE does not hold the cursor back.
  writeState({ historyId: "100" });
  const calls = fakeGmail({
    pages: [{ history: [added("tA")], historyId: "300" }, { history: [added("tB")], historyId: "301" }],
    threads: { tA: [promoMessage("tA")], tB: [promoMessage("tB")] },
    profile: new Error('429 {"error":{"message":"rate limited"}}'),
  });
  const result = await syncIncremental();
  assert.equal(result.error, undefined);
  assert.deepEqual(fetchedThreads(calls).sort(), ["tA", "tB"]);
  assert.equal(profileCalls(calls), 0);
  assert.equal(readState().historyId, "301");
  assert.equal(readState().lastError, undefined);
}

{
  // Scenario "History with no thread changes".
  writeState({ historyId: "100" });
  const calls = fakeGmail({ pages: [{ history: [deleted("tDel")], historyId: "400" }] });
  await syncIncremental();
  assert.equal(profileCalls(calls), 0);
  assert.deepEqual(fetchedThreads(calls), []);
  assert.equal(readState().historyId, "400");
}

{
  // Scenario "The history listing fails": the cursor stays, so the next run lists the same history.
  writeState({ historyId: "100" });
  const calls = fakeGmail({
    pages: [{ history: [added("tA")], historyId: "500" }, "Error executing the tool GMAIL_LIST_HISTORY"],
    threads: { tA: [promoMessage("tA")] },
  });
  const result = await syncIncremental();
  assert.match(result.error, /GMAIL_LIST_HISTORY/);
  assert.deepEqual(fetchedThreads(calls), []);
  assert.equal(readState().historyId, "100");
}

{
  // Scenario "No cursor yet": GMAIL_GET_PROFILE seeds the cursor.
  fs.rmSync(statePath);
  const calls = fakeGmail({ profile: "600" });
  await syncIncremental();
  assert.equal(profileCalls(calls), 1);
  assert.equal(readState().historyId, "600");
}

setGmailToolsExecuteForTests();

// Requirement "A connector cron job runs one time at a time".
{
  const job = { id: "sync-gmail", name: "Sync owner Gmail mirror", schedule: "every 1m", action: "sync_composio_gmail", enabled: true };
  const other = { id: "poll-nylas", name: "Poll Nylas agent inbox", schedule: "every 1m", action: "sync_nylas", enabled: true };
  await writeConnectorCronJobs(process.cwd(), [other, job]);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runs = [];
  const runner = async (_root, j) => {
    runs.push(j.id);
    if (j.id === "sync-gmail") await gate;
    return j.id === "sync-gmail" ? "boom" : undefined;
  };

  const first = tickConnectorCron(process.cwd(), runner);
  // Let the first tick start sync-gmail.
  for (let i = 0; i < 50 && !runs.includes("sync-gmail"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(runs, ["poll-nylas", "sync-gmail"]);

  // Scenario "A run takes longer than the tick": lastRunAt is saved at the start of the run.
  const started = (await readConnectorCronJobs(process.cwd())).find((j) => j.id === "sync-gmail");
  assert.ok(started.lastRunAt);

  // A later tick while sync-gmail runs does not start it again, also when the job is due by time.
  const jobs = await readConnectorCronJobs(process.cwd());
  for (const j of jobs) j.lastRunAt = new Date(Date.now() - 120_000).toISOString();
  await writeConnectorCronJobs(process.cwd(), jobs);
  await tickConnectorCron(process.cwd(), runner);
  assert.deepEqual(runs, ["poll-nylas", "sync-gmail", "poll-nylas"]);

  // Scenario "An operator turns the job off during a run".
  const edited = await readConnectorCronJobs(process.cwd());
  edited.find((j) => j.id === "sync-gmail").enabled = false;
  await writeConnectorCronJobs(process.cwd(), edited);

  release();
  await first;
  const after = (await readConnectorCronJobs(process.cwd())).find((j) => j.id === "sync-gmail");
  assert.equal(after.enabled, false);
  assert.equal(after.lastError, "boom");

  // A turned-off job does not run.
  await tickConnectorCron(process.cwd(), runner);
  assert.equal(runs.filter((id) => id === "sync-gmail").length, 1);
}

fs.rmSync(arozData, { recursive: true, force: true });
console.log("ok test-gmail-sync-cursor");
