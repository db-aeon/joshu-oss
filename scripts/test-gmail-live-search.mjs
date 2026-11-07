#!/usr/bin/env npx tsx
/**
 * Unit tests: live Gmail search across owner Gmail accounts (spec gmail-live-search,
 * change gmail-live-search). No Composio call: the tests replace the Gmail tool call.
 *
 * Usage: npm run test:gmail-live-search
 */
import assert from "node:assert/strict";

import { searchGmailMessages, setGmailToolsExecuteForTests } from "../src/connectors/composio/gmail.js";
import {
  GmailLiveSearchError,
  searchOwnerGmailLive,
} from "../src/connectors/composio/gmailLiveSearch.js";

const ROOT = "/tmp/joshu-test-gmail-live-search";

const accountA = { connectedAccountId: "ca_A", accountKey: "a_at_example_com", email: "a@example.com", enabled: true, isDefault: true };
const accountB = { connectedAccountId: "ca_B", accountKey: "b_at_example_com", email: "b@example.com", enabled: true };

/** One message row as GMAIL_FETCH_EMAILS returns it with verbose false. */
function row(id, isoTime, sender, subject, labelIds) {
  return {
    messageId: id,
    threadId: id,
    messageTimestamp: isoTime,
    sender,
    subject,
    labelIds,
    messageText: "",
    preview: { body: `${subject} preview text`, subject },
  };
}

/** Fake Gmail search: messages by connected account id; an Error rejects that account. */
function fakeSearch(byAccount, calls = []) {
  return async (_root, ctx, opts) => {
    calls.push({ ctx, opts });
    const value = byAccount[ctx.connectedAccountId];
    if (value instanceof Error) throw value;
    return value ?? [];
  };
}

const summary = (id, ms, from, subject, labelIds) => ({ id, threadId: id, messageTimestamp: ms, from, subject, snippet: "s", labelIds });

// --- searchGmailMessages: Composio arguments and the snippet of preview.body --------------

{
  const seen = [];
  setGmailToolsExecuteForTests(async (slug, params) => {
    seen.push({ slug, params });
    return {
      successful: true,
      data: { messages: [row("m1", "2026-11-02T03:34:33Z", "Carrd <notifications@carrd.com>", "Verify your Carrd account", ["INBOX", "CATEGORY_UPDATES"])] },
    };
  });
  const out = await searchGmailMessages(ROOT, { connectedAccountId: "ca_B" }, { query: "carrd", maxResults: 5 });
  setGmailToolsExecuteForTests();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].slug, "GMAIL_FETCH_EMAILS");
  assert.equal(seen[0].params.connectedAccountId, "ca_B", "searches with the connection of the owner Gmail account");
  assert.deepEqual(seen[0].params.arguments, {
    user_id: "me",
    query: "carrd",
    max_results: 5,
    include_payload: false,
    verbose: false,
    include_spam_trash: true,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, "Verify your Carrd account");
  assert.equal(out[0].snippet, "Verify your Carrd account preview text");
  assert.equal(out[0].messageTimestamp, Date.parse("2026-11-02T03:34:33Z"), "reads the ISO messageTimestamp");
  assert.deepEqual(out[0].labelIds, ["INBOX", "CATEGORY_UPDATES"]);
}

{
  let args;
  setGmailToolsExecuteForTests(async (_slug, params) => {
    args = params.arguments;
    return { successful: true, data: { messages: [] } };
  });
  await searchGmailMessages(ROOT, { connectedAccountId: "ca_A" }, { query: "x", maxResults: 1, includeSpamTrash: false });
  setGmailToolsExecuteForTests();
  assert.equal(args.include_spam_trash, false, "includeSpamTrash false leaves out spam and trash");
}

// --- Scenario: The email is in a second owner Gmail account ------------------------------

{
  const calls = [];
  const result = await searchOwnerGmailLive(
    ROOT,
    { query: "from:carrd.com" },
    {
      listAccounts: async () => [accountA, accountB],
      search: fakeSearch({ ca_B: [summary("m1", 1000, "Carrd <notifications@carrd.com>", "Verify", ["INBOX", "CATEGORY_UPDATES"])] }, calls),
    },
  );
  assert.equal(calls.length, 2, "searches each enabled owner Gmail account");
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].connectedAccountId, "ca_B");
  assert.equal(result.hits[0].accountEmail, "b@example.com");
  // Scenario: The mail mirror skipped the email (the hit keeps its bulk label).
  assert.deepEqual(result.hits[0].labels, ["INBOX", "CATEGORY_UPDATES"]);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.accounts.map((a) => [a.connectedAccountId, a.ok, a.hits]), [["ca_A", true, 0], ["ca_B", true, 1]]);
  assert.equal(calls[0].opts.includeSpamTrash, undefined, "spam and trash stay included by default");
}

// --- Scenario: A disabled owner Gmail account ---------------------------------------------

{
  const calls = [];
  await searchOwnerGmailLive(ROOT, { query: "x" }, {
    listAccounts: async () => [accountA, { ...accountB, enabled: false }],
    search: fakeSearch({}, calls),
  });
  assert.deepEqual(calls.map((c) => c.ctx.connectedAccountId), ["ca_A"]);
}

// --- connectedAccountId searches one owner Gmail account ----------------------------------

{
  const calls = [];
  await searchOwnerGmailLive(ROOT, { query: "x", connectedAccountId: "ca_B" }, {
    listAccounts: async () => [accountA, accountB],
    search: fakeSearch({}, calls),
  });
  assert.deepEqual(calls.map((c) => c.ctx.connectedAccountId), ["ca_B"]);
}

// --- Scenario: A verification email in spam -----------------------------------------------

{
  const result = await searchOwnerGmailLive(ROOT, { query: "verify" }, {
    listAccounts: async () => [accountA],
    search: fakeSearch({ ca_A: [summary("s1", 1000, "x@y.com", "Verify", ["SPAM"])] }),
  });
  assert.deepEqual(result.hits[0].labels, ["SPAM"]);
}

// --- Scenario: One owner Gmail account fails ----------------------------------------------

{
  const result = await searchOwnerGmailLive(ROOT, { query: "x" }, {
    listAccounts: async () => [accountA, accountB],
    search: fakeSearch({ ca_A: [summary("m1", 1000, "a", "s", ["INBOX"])], ca_B: new Error("HTTP 403") }),
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.incomplete, true);
  const b = result.accounts.find((a) => a.connectedAccountId === "ca_B");
  assert.equal(b.ok, false);
  assert.equal(b.error, "HTTP 403");
}

// --- Scenario: Each owner Gmail account fails ---------------------------------------------

await assert.rejects(
  searchOwnerGmailLive(ROOT, { query: "x" }, {
    listAccounts: async () => [accountA, accountB],
    search: fakeSearch({ ca_A: new Error("down"), ca_B: new Error("down") }),
  }),
  (err) => err instanceof GmailLiveSearchError && err.status === 502 && err.accounts.length === 2,
);

// --- Scenario: Hits from two owner Gmail accounts (newest first, cut to the limit) --------

{
  const t0334 = Date.parse("2026-11-02T03:34:00Z");
  const t0341 = Date.parse("2026-11-02T03:41:00Z");
  const result = await searchOwnerGmailLive(ROOT, { query: "x" }, {
    listAccounts: async () => [accountA, accountB],
    search: fakeSearch({ ca_A: [summary("a1", t0334, "a", "A", [])], ca_B: [summary("b1", t0341, "b", "B", [])] }),
  });
  assert.deepEqual(result.hits.map((h) => h.messageId), ["b1", "a1"]);
  assert.equal(result.hits[0].date, "2026-11-02T03:41:00.000Z");

  const many = Array.from({ length: 40 }, (_, i) => summary(`m${i}`, i, "a", "s", []));
  const capped = await searchOwnerGmailLive(ROOT, { query: "x", limit: 500 }, {
    listAccounts: async () => [accountA, accountB],
    search: fakeSearch({ ca_A: many, ca_B: many }),
  });
  assert.equal(capped.hits.length, 50, "at most 50 hits");
  const byDefault = await searchOwnerGmailLive(ROOT, { query: "x" }, {
    listAccounts: async () => [accountA],
    search: fakeSearch({ ca_A: many }),
  });
  assert.equal(byDefault.hits.length, 20, "20 hits by default");
}

// --- Scenario: No query, and no owner Gmail account ---------------------------------------

await assert.rejects(
  searchOwnerGmailLive(ROOT, { query: "  " }, { listAccounts: async () => [accountA], search: fakeSearch({}) }),
  (err) => err instanceof GmailLiveSearchError && err.status === 400,
);
await assert.rejects(
  searchOwnerGmailLive(ROOT, { query: "x" }, { listAccounts: async () => [], search: fakeSearch({}) }),
  (err) => err instanceof GmailLiveSearchError && err.status === 404,
);

console.log("test-gmail-live-search: ok");
