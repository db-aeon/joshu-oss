/**
 * Unit tests of the Watch migration (change recurring-research-reports, task 8.1): on a temporary
 * tree with a research.db of 9 watched topics and a copy of the Hermes cron jobs of gideon (owner
 * data removed), the migration makes one recurring report with the schedule and channel of the
 * custom digest, notes without recipients or tool names, copies of the jobs, and removes the custom
 * job. A second boot does nothing, and a box with no topics gets no recurring report. Needs Node 22
 * (node:sqlite). No network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { RecurringStore } from "../src/research/recurring/store.ts";
import { RecurringService } from "../src/research/recurring/service.ts";
import { migrateWatch, migrationMarkerPath, WATCH_REPORT_NAME } from "../src/research/recurring/watchMigration.ts";

const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "test", "fixtures", "research", "watch", "gideon.json"), "utf8"));
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

function makeDb(file, topics) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, search_queries TEXT, schedule TEXT, enabled INTEGER DEFAULT 1)");
  const insert = db.prepare("INSERT INTO topics (name, search_queries, schedule, enabled) VALUES (?, ?, ?, ?)");
  topics.forEach((t, i) => insert.run(t, i === 0 ? JSON.stringify(["robotics startups", "robot arms"]) : null, "0 8 * * *", 1));
  insert.run("Old topic", null, "0 8 * * *", 0);
  db.close();
}

/** A fake OpenRouter: the plan call and the notes call. The notes answer leaves an address in, which the box must drop. */
function model(requests) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const user = body.messages[1].content;
    const system = body.messages[0].content;
    const content = system.startsWith("You turn the instructions")
      ? { notes: "At most 8 items. ALL-CAPS headings for the parts, in order. One line starting Why it matters for each item. Plain text. Send to owner@example.com." }
      : { lanes: [...user.matchAll(/^\d+\. (.*?)(?: \(hints|$)/gm)].map((m) => ({ topic: m[1], picks: ["web", "x"], reason: "r", web_queries: [m[1], m[1]], news_query: m[1], social_query: m[1], scholar_query: "", company: null })) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
}

function setup(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-migration-"));
  const roots = { desktopRoot: root, filesRoot: path.join(root, "files") };
  fs.mkdirSync(roots.filesRoot, { recursive: true });
  const joshuDir = path.join(root, ".joshu");
  if (opts.topics !== false) makeDb(path.join(joshuDir, "last30days", "share", "research.db"), fixture.topics);
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "last30days-digest-data.py"), "print('data')\n");
  let jobs = structuredClone(opts.jobs ?? fixture.jobs);
  const calls = [];
  let n = 0;
  const cron = async (p) => {
    calls.push(p);
    if (p.action === "list") return { success: true, jobs: jobs.map((j) => ({ job_id: j.job_id, name: j.name, prompt_preview: (j.prompt ?? "").slice(0, 40) })) };
    if (p.action === "get") return { success: true, job: jobs.find((j) => j.job_id === p.job_id) };
    if (p.action === "remove") {
      jobs = jobs.filter((j) => j.job_id !== p.job_id);
      return { success: true };
    }
    if (p.action === "create") return { success: true, job_id: `new${++n}`, job: { next_run_at: "2026-11-02T07:00:00-08:00" } };
    return { success: true };
  };
  const requests = [];
  const store = new RecurringStore(roots);
  const service = new RecurringService({ projectRoot: root, store, scriptsDir, cron, now: () => new Date("2026-10-30T17:00:00.000Z"), available: () => ["web", "x", "reddit"], llm: { fetchImpl: model(requests), apiKey: "k", model: "m" } });
  const deps = {
    joshuDir,
    scriptsDir,
    service,
    cron,
    profileEmails: () => opts.profile ?? ["owner@example.com", "owner.home@example.com"],
    ownerTextChannel: () => opts.text ?? "sms",
    now: () => new Date("2026-10-30T17:00:00.000Z"),
    llm: { fetchImpl: model(requests), apiKey: "k", model: "m" },
  };
  return { root, roots, store, deps, calls, requests, jobs: () => jobs };
}

async function testCustomDigest() {
  const t = setup();
  try {
    const result = await migrateWatch(t.deps);
    assert.equal(result.ran, true, JSON.stringify(result));
    assert.equal(result.topics, 9);
    const report = t.store.get(result.reportId);
    assert.equal(report.name, WATCH_REPORT_NAME);
    assert.equal(report.lanes.length, 9, "one part for each enabled watched topic");
    assert.deepEqual(report.lanes[0].hints, ["robotics startups", "robot arms"], "the search queries are hints");
    assert.equal(report.schedule, "0 7 * * 1-5", "the schedule of the custom digest");
    assert.equal(report.channel, "email", "the custom digest sends mail");
    assert.deepEqual(report.emailTo, ["owner@example.com", "owner.home@example.com"], "both owner addresses of the profile");
    assert.equal(report.sources, "auto");
    assert.equal(report.origin, "watch-migration");
    assert.match(report.notes, /At most 8 items/);
    assert.doesNotMatch(report.notes, /@|nylas|mcp__/i, "no recipients or tool names in the notes");
    const notesCall = t.requests.find((r) => r.messages[0].content.startsWith("You turn the instructions"));
    assert.equal(notesCall.provider.data_collection, "deny", "no-training routing");

    const migration = path.join(t.store.folder(report), "migration");
    for (const id of ["c350b417920b", "043b0c4cf42b", "ee0451ee9eda"]) assert.ok(fs.existsSync(path.join(migration, `${id}.json`)), `copy of ${id}`);
    assert.ok(fs.existsSync(path.join(migration, "last30days-digest-data.py")), "copy of the script of the custom job");
    assert.ok(!fs.existsSync(path.join(migration, "a1b2c3d4e5f6.json")), "an unrelated job is not touched");
    assert.deepEqual(result.removed, ["ee0451ee9eda"], "the custom job is removed");
    assert.deepEqual(t.jobs().map((j) => j.job_id).sort(), ["043b0c4cf42b", "a1b2c3d4e5f6", "c350b417920b"], "the Watch jobs stay for the cleanup of last30days");
    assert.ok(fs.existsSync(migrationMarkerPath(t.deps.joshuDir)));

    const again = await migrateWatch(t.deps);
    assert.equal(again.ran, false, "a second boot does nothing");
    assert.equal(t.store.list().length, 1);
    console.log("ok Watch migration with a custom digest: 9 parts, schedule, email to both profile addresses, notes, copies");
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
}

async function testWithoutCustomDigest() {
  const t = setup({ jobs: fixture.jobs.filter((j) => j.job_id !== "ee0451ee9eda"), profile: ["owner@example.com"] });
  try {
    const result = await migrateWatch(t.deps);
    const report = t.store.get(result.reportId);
    assert.equal(report.schedule, "0 8 * * *", "the schedule of the daily Watch job");
    assert.equal(report.channel, "sms", "the owner text channel");
    assert.equal(report.notes, "");
    assert.deepEqual(result.removed, []);
    console.log("ok Watch migration without a custom digest: daily schedule, owner text channel");
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
}

async function testAddressNotInProfile() {
  const t = setup({ profile: ["owner@example.com"] });
  try {
    const result = await migrateWatch(t.deps);
    assert.deepEqual(t.store.get(result.reportId).emailTo, ["owner@example.com"], "an address that is not in the profile is left out");
    console.log("ok Watch migration keeps only profile addresses");
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
}

async function testNoTopics() {
  const t = setup({ topics: false });
  try {
    const result = await migrateWatch(t.deps);
    assert.equal(result.ran, true);
    assert.equal(result.reportId, undefined);
    assert.deepEqual(t.store.list(), [], "no recurring report without watched topics");
    assert.ok(!t.calls.some((c) => c.action === "create" || c.action === "remove"));
    assert.ok(fs.existsSync(migrationMarkerPath(t.deps.joshuDir)));
    console.log("ok Watch migration with no topics makes no recurring report");
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
}

await testCustomDigest();
await testWithoutCustomDigest();
await testAddressNotInProfile();
await testNoTopics();
console.log("research Watch migration: all tests passed");
