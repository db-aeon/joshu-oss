#!/usr/bin/env npx tsx
/**
 * Unit tests: Multiplayer teams (openspec change box-teams-standup, specs team-room and team-standup).
 * Real team room store, routes, and membership; fake HTTPS between boxes, owner text channel,
 * Kanban bridge, and cron bridge.
 *
 * Usage: npm run test:teams
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";
import { readFile, readdir } from "node:fs/promises";

import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { buildProactiveResolveSystemMessage, skillForBoard } from "../src/proactive/resolveOwnerReply.js";
import { boardForTaskRef, factoryProactiveState, recordOwnerQuestionText } from "../src/proactive/state.js";
import { buildHermesContextMarkdown } from "../src/hermesContextFile.js";
import { syncTeamMcpServers } from "../src/teams/hermesConfig.js";
import { MembershipStore, parseInviteLink } from "../src/teams/membership.js";
import { registerTeamRoutes } from "../src/teams/routes.js";
import { TeamService, teamNotesTemplate } from "../src/teams/service.js";
import { findWakeTriggers, inWakeWindow, MAX_EARLY_STANDUPS_PER_DAY } from "../src/teams/wake.js";
import {
  INVITE_DAYS,
  MAX_AVATAR_BYTES,
  MAX_DAILY_WRITES,
  MAX_MESSAGE_CHARS,
  TeamRoomStore,
} from "../src/teams/roomStore.js";

const root = await mkdtemp(path.join(tmpdir(), "joshu-teams-"));
let clock = new Date("2026-10-08T12:00:00.000Z");
const now = () => clock;
const DAY = 24 * 60 * 60 * 1000;
const PNG = { mime: "image/png", base64: Buffer.from("fake png").toString("base64") };
const maya = { ownerName: "Maya", companionName: "Mina", avatar: PNG };
const sam = { ownerName: "Sam", companionName: "Otto" };
const lee = { ownerName: "Lee", companionName: "Iris" };
let n = 0;
const freshStore = () => new TeamRoomStore(path.join(root, `teams-${n++}`), now);

async function studio() {
  const store = freshStore();
  const created = await store.createTeam({ slug: "studio", charter: "Client work. Weekdays 08:45.", boss: maya });
  assert.equal(created.status, 201);
  const join = async (profile) => {
    const inv = await store.makeInvite("studio");
    const j = await store.join(inv.body.code, profile);
    assert.equal(j.status, 201, JSON.stringify(j.body));
    return j.body;
  };
  const b = await join(sam);
  const c = await join(lee);
  return { store, boss: created.body, b, c };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("create team: boss is the first team member", async () => {
  const store = freshStore();
  const out = await store.createTeam({ slug: "acme", charter: "Acme Ops", boss: maya });
  assert.equal(out.status, 201);
  const read = await store.read("acme", out.body.memberId);
  assert.equal(read.body.room.members.length, 1);
  assert.equal(read.body.room.members[0].isBoss, true);
  assert.equal(read.body.room.members[0].label, "Maya's Joshu (Mina)");
  assert.equal((await store.createTeam({ slug: "acme", charter: "x", boss: maya })).status, 409);
  assert.equal((await store.createTeam({ slug: "Bad Slug!", charter: "x", boss: maya })).status, 400);
});

test("invite code: single use", async () => {
  const store = freshStore();
  await store.createTeam({ slug: "acme", charter: "Acme", boss: maya });
  const inv = await store.makeInvite("acme");
  assert.equal((await store.join(inv.body.code, sam)).status, 201);
  assert.equal((await store.join(inv.body.code, lee)).status, 404);
});

test("invite code: expires after 7 days", async () => {
  const store = freshStore();
  await store.createTeam({ slug: "acme", charter: "Acme", boss: maya });
  const inv = await store.makeInvite("acme");
  const saved = clock;
  clock = new Date(saved.getTime() + (INVITE_DAYS + 1) * DAY);
  try {
    assert.equal((await store.join(inv.body.code, sam)).status, 404);
  } finally {
    clock = saved;
  }
});

test("join: avatar limits", async () => {
  const store = freshStore();
  await store.createTeam({ slug: "acme", charter: "Acme", boss: maya });
  const big = { mime: "image/png", base64: Buffer.alloc(MAX_AVATAR_BYTES + 1).toString("base64") };
  assert.equal((await store.join((await store.makeInvite("acme")).body.code, { ...sam, avatar: big })).status, 413);
  const gif = { mime: "image/gif", base64: PNG.base64 };
  assert.equal((await store.join((await store.makeInvite("acme")).body.code, { ...sam, avatar: gif })).status, 400);
});

test("member tokens: authenticate only active members of the team", async () => {
  const { store, b } = await studio();
  assert.ok(await store.authenticate("studio", b.token));
  assert.equal(await store.authenticate("studio", "wrong"), undefined);
  assert.equal(await store.authenticate("other", b.token), undefined);
  assert.equal((await store.removeMember("studio", b.memberId)).status, 200);
  assert.equal(await store.authenticate("studio", b.token), undefined);
  assert.equal((await store.read("studio", b.memberId)).status, 404);
});

test("messages: id, author, reply link, 4000 characters", async () => {
  const { store, boss, b } = await studio();
  const ask = await store.post("studio", boss.memberId, { text: "I need the new price list." });
  const answer = await store.post("studio", b.memberId, { text: "40, 65, 90", inReplyTo: ask.body.entry.id });
  assert.equal(answer.body.entry.inReplyTo, ask.body.entry.id);
  assert.equal(answer.body.entry.author, b.memberId);
  assert.equal((await store.post("studio", b.memberId, { text: "x".repeat(MAX_MESSAGE_CHARS + 1) })).status, 413);
});

test("read: cursor, order, and 7 days without a cursor", async () => {
  const { store, boss, b } = await studio();
  const saved = clock;
  clock = new Date(saved.getTime() - 10 * DAY);
  await store.post("studio", boss.memberId, { text: "old" });
  clock = saved;
  const first = await store.post("studio", boss.memberId, { text: "one" });
  await store.post("studio", b.memberId, { text: "two" });
  const all = await store.read("studio", b.memberId);
  assert.deepEqual(all.body.room.entries.map((e) => e.text), ["one", "two"]);
  const after = await store.read("studio", b.memberId, first.body.entry.id);
  assert.deepEqual(after.body.room.entries.map((e) => e.text), ["two"]);
});

test("limits: 50 messages and card changes each day, 90-day retention", async () => {
  const { store, boss, b } = await studio();
  await store.card("studio", boss.memberId, { op: "project_add", code: "HAR", name: "Harbor rebrand" });
  await store.card("studio", b.memberId, { op: "create", title: "Q4 price list", project: "HAR" });
  for (let i = 1; i < MAX_DAILY_WRITES; i += 1) assert.equal((await store.post("studio", b.memberId, { text: `m${i}` })).status, 201);
  assert.equal((await store.post("studio", b.memberId, { text: "one too many" })).status, 429);
  assert.equal((await store.card("studio", b.memberId, { op: "create", title: "x", project: "HAR" })).status, 429);
  const saved = clock;
  clock = new Date(saved.getTime() + 91 * DAY);
  try {
    await store.post("studio", boss.memberId, { text: "much later" });
    const read = await store.read("studio", boss.memberId, "m_0");
    assert.deepEqual(read.body.room.entries.map((e) => e.text), ["much later"]);
  } finally {
    clock = saved;
  }
});

test("cards: ids, events, and who may change what", async () => {
  const { store, boss, b, c } = await studio();
  assert.equal((await store.card("studio", b.memberId, { op: "create", title: "x", project: "HAR" })).status, 400);
  assert.equal((await store.card("studio", b.memberId, { op: "project_add", code: "HAR", name: "Harbor rebrand" })).status, 200);
  const created = await store.card("studio", boss.memberId, { op: "create", title: "Q4 price list", project: "HAR", doer: b.memberId });
  assert.equal(created.body.card.id, "HAR-1");
  assert.equal(created.body.card.state, "todo");
  assert.equal(created.body.card.asker, boss.memberId);
  // Only the assigned team member changes the state.
  assert.equal((await store.card("studio", c.memberId, { op: "update", card: "HAR-1", state: "done" })).status, 403);
  assert.equal((await store.card("studio", boss.memberId, { op: "update", card: "HAR-1", state: "done" })).status, 403);
  const done = await store.card("studio", b.memberId, { op: "update", card: "HAR-1", state: "done" });
  assert.equal(done.body.card.state, "done");
  // Only the team boss reassigns.
  assert.equal((await store.card("studio", b.memberId, { op: "update", card: "HAR-1", doer: c.memberId })).status, 403);
  assert.equal((await store.card("studio", boss.memberId, { op: "update", card: "HAR-1", doer: c.memberId })).status, 200);
  const events = (await store.read("studio", c.memberId)).body.room.entries.filter((e) => e.kind === "event").map((e) => e.text);
  assert.deepEqual(events, ['Mina created HAR-1 "Q4 price list" for Otto', "Otto moved HAR-1 to Done", "Mina gave HAR-1 to Iris"]);
  // Project rename is for the team boss only.
  assert.equal((await store.card("studio", b.memberId, { op: "project_rename", code: "HAR", name: "Harbor" })).status, 403);
  assert.equal((await store.card("studio", boss.memberId, { op: "project_rename", code: "HAR", name: "Harbor" })).status, 200);
});

test("messages name team cards: copies keep the state of the post; unknown or too many cards are rejected", async () => {
  const { store, boss, b } = await studio();
  await store.card("studio", boss.memberId, { op: "project_add", code: "HAR", name: "Harbor rebrand" });
  await store.card("studio", b.memberId, { op: "create", title: "Moodboard", project: "HAR", state: "done" });
  await store.card("studio", b.memberId, { op: "create", title: "Q4 price list", project: "HAR", state: "waiting", waitingOn: "Maya's OK" });
  const posted = await store.post("studio", b.memberId, { text: "I closed one and I still wait on one", cards: ["HAR-1", "har-2"] });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual(posted.body.entry.cards, [
    { id: "HAR-1", title: "Moodboard", state: "done", doer: b.memberId },
    { id: "HAR-2", title: "Q4 price list", state: "waiting", doer: b.memberId, waitingOn: "Maya's OK" },
  ]);
  await store.card("studio", b.memberId, { op: "update", card: "HAR-2", state: "done" });
  const msg = (await store.read("studio", boss.memberId)).body.room.entries.find((e) => e.id === posted.body.entry.id);
  assert.equal(msg.cards[1].state, "waiting", "the copy keeps the state of the post");
  assert.equal((await store.post("studio", b.memberId, { text: "x", cards: ["HAR-99"] })).status, 400);
  const many = Array.from({ length: 11 }, (_, i) => `HAR-${i + 1}`);
  assert.equal((await store.post("studio", b.memberId, { text: "x", cards: many })).status, 400);
  const plain = await store.post("studio", b.memberId, { text: "no cards", viaOwner: true });
  assert.equal(plain.body.entry.cards, undefined);
  assert.equal(plain.body.entry.viaOwner, true);
});

test("read positions: only the read of the team stand-up moves them, and each read returns them", async () => {
  const { store, boss, b } = await studio();
  const first = await store.post("studio", boss.memberId, { text: "one" });
  const chat = await store.read("studio", b.memberId);
  assert.deepEqual(chat.body.room.seen, {}, "a read in chat does not move the read position");
  await store.read("studio", b.memberId, undefined, { seen: true });
  assert.deepEqual((await store.read("studio", boss.memberId)).body.room.seen, { [b.memberId]: first.body.entry.id });
  await store.post("studio", boss.memberId, { text: "two" });
  await store.read("studio", b.memberId, first.body.entry.id);
  assert.deepEqual((await store.read("studio", boss.memberId)).body.room.seen, { [b.memberId]: first.body.entry.id });
  const room = JSON.parse(await readFile(path.join(store.hostedDir, "studio", "room.json"), "utf8"));
  assert.equal(room.members.find((m) => m.id === b.memberId).seenSeq, first.body.entry.seq);
  assert.equal(JSON.stringify((await store.read("studio", boss.memberId)).body.room.members).includes("seenSeq"), false);
});

test("read window: 90 days on request, 7 days by default", async () => {
  const { store, boss } = await studio();
  const saved = clock;
  clock = new Date(saved.getTime() - 30 * DAY);
  await store.post("studio", boss.memberId, { text: "a month ago" });
  clock = saved;
  await store.post("studio", boss.memberId, { text: "today" });
  assert.deepEqual((await store.read("studio", boss.memberId)).body.room.entries.map((e) => e.text), ["today"]);
  assert.deepEqual((await store.read("studio", boss.memberId, undefined, { days: 90 })).body.room.entries.map((e) => e.text), ["a month ago", "today"]);
});

test("card event texts stay as the Multiplayer app reads them back", async () => {
  const { store, boss, b } = await studio();
  await store.card("studio", boss.memberId, { op: "project_add", code: "HAR", name: "Harbor rebrand" });
  await store.card("studio", boss.memberId, { op: "create", title: "Q4 price list", project: "HAR", doer: b.memberId });
  await store.card("studio", b.memberId, { op: "update", card: "HAR-1", state: "waiting", waitingOn: "Maya's OK" });
  await store.card("studio", b.memberId, { op: "update", card: "HAR-1", state: "doing", waitingOn: "" });
  const events = (await store.read("studio", boss.memberId)).body.room.entries.map((e) => e.text);
  assert.deepEqual(events, [
    'Mina created HAR-1 "Q4 price list" for Otto',
    "Otto moved HAR-1 to Waiting on a person; set HAR-1 waiting on Maya's OK",
    "Otto moved HAR-1 to Doing; cleared the waiting-on text of HAR-1",
  ]);
});

test("leave: the member token stops working", async () => {
  const { store, c } = await studio();
  assert.equal((await store.leave("studio", c.memberId)).status, 200);
  assert.equal(await store.authenticate("studio", c.token), undefined);
});



// —— Two boxes with real HTTP between them ——
const servers = [];
async function box(label, profile) {
  const dir = path.join(root, `box-${label}-${n++}`);
  const filesRoot = path.join(dir, "files");
  const store = new TeamRoomStore(path.join(dir, "teams"), now);
  const memberships = new MembershipStore(path.join(dir, "teams"));
  const b = { label, dir, filesRoot, store, memberships, sent: [], cron: [], kanban: [], tasks: [], resolved: [], questions: [], teamsChanged: 0, base: "" };
  b.service = new TeamService({
    projectRoot: dir,
    store,
    memberships,
    filesRoot,
    fetch: (url, init) => fetch(url, init),
    publicBaseUrl: () => b.base,
    profile: async () => profile,
    sendText: async (input) => {
      b.sent.push(input);
      return { delivered: true, channel: "sms" };
    },
    cron: async (payload) => {
      b.cron.push(payload);
      if (payload.action === "get") {
        return { success: true, job: { ...(b.lastRunAt ? { last_run_at: b.lastRunAt } : {}), ...(b.jobToolsets ? { enabled_toolsets: b.jobToolsets } : {}) } };
      }
      return payload.action === "create" ? { success: true, job_id: `job-${b.cron.length}` } : { success: true };
    },
    kanban: async (payload) => {
      b.kanban.push(payload);
      if (payload.action === "create") {
        const task_id = `t_${(0xa0000000 + b.kanban.length).toString(16)}`;
        b.tasks.push({ task_id, board: payload.board, title: payload.title, body: payload.body, status: "ready", block_kind: null });
        return { success: true, task_id };
      }
      const task = b.tasks.find((t) => t.task_id === payload.task_id && t.board === payload.board);
      if (payload.action === "block" && task) Object.assign(task, { status: "blocked", block_kind: payload.kind ?? null, block_reason: payload.reason });
      if (payload.action === "show") return task ? { success: true, task } : { success: false, error: "not found" };
      if (payload.action === "list") return { success: true, tasks: b.tasks.filter((t) => t.board === payload.board) };
      if (payload.action === "list_blocked") {
        const skip = (board) => board.startsWith(payload.exclude_prefix) && !(payload.include_boards ?? []).includes(board);
        return { success: true, truncated: false, tasks: b.tasks.filter((t) => t.status === "blocked" && !skip(t.board)) };
      }
      return { success: true };
    },
    resolveOwnerReply: async (input) => {
      b.resolved.push(input);
      return { ok: true, action: "resolved" };
    },
    standupModel: () => "test/model",
    onTeamsChanged: async () => {
      b.teamsChanged += 1;
    },
    ownerToday: () => clock.toISOString().slice(0, 10),
    ownerClock: () => ({
      date: clock.toISOString().slice(0, 10),
      hour: clock.getUTCHours(),
      weekday: clock.toLocaleString("en-US", { weekday: "long", timeZone: "UTC" }),
    }),
    ensureOwnerTimezone: async () => {
      b.tzSyncs = (b.tzSyncs ?? 0) + 1;
    },
    recordOwnerQuestion: (nudge) => b.questions.push(nudge),
    now,
  });
  const app = express();
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));
  registerTeamRoutes(router, { service: () => b.service, store: () => store });
  app.use("/joshu", router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  b.base = `http://127.0.0.1:${server.address().port}/joshu`;
  b.call = (method, p, body, headers = {}) =>
    fetch(`${b.base}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), text: r.headers.get("content-type")?.includes("html") ? "html" : "" }));
  return b;
}

async function twoBoxes() {
  const boss = await box("maya", maya);
  const member = await box("sam", sam);
  const created = await boss.service.create({ slug: "studio", charter: "Client work. Weekdays at 08:45." });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const inv = await boss.service.invite("studio");
  assert.equal(inv.status, 201);
  const preview = await member.service.preview(inv.body.link);
  assert.equal(preview.body.charter, "Client work. Weekdays at 08:45.");
  assert.equal(preview.body.boss, "Maya's Joshu (Mina)");
  const joined = await member.service.join({ inviteLink: inv.body.link });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  return { boss, member, joined: joined.body };
}

test("invite link: parse", () => {
  assert.deepEqual(parseInviteLink("https://example-box.box.joshu.me/joshu/teams/join/AbCdEfGhIjKlMnOpQrStUv"), {
    bossUrl: "https://example-box.box.joshu.me/joshu",
    code: "AbCdEfGhIjKlMnOpQrStUv",
  });
  assert.equal(parseInviteLink("http://evil.example/teams/join/AbCdEfGhIjKlMnOpQrStUv"), undefined);
  assert.equal(parseInviteLink("https://x.example/teams/join/short"), undefined);
});

test("2.2 public routes: member token checks give one 404", async () => {
  const { boss, member } = await twoBoxes();
  const token = (await member.memberships.find("studio")).token;
  assert.equal((await boss.call("GET", "/api/teams/studio/room")).status, 404);
  assert.equal((await boss.call("GET", "/api/teams/studio/room", null, { Authorization: "Bearer nope" })).status, 404);
  assert.equal((await boss.call("GET", "/api/teams/other/room", null, { Authorization: `Bearer ${token}` })).status, 404);
  assert.equal((await boss.call("GET", "/api/teams/studio/room", null, { Authorization: `Bearer ${token}` })).status, 200);
  const mid = (await member.memberships.find("studio")).memberId;
  assert.equal((await boss.service.removeMember("studio", mid)).status, 200);
  const after = await boss.call("POST", "/api/teams/studio/messages", { text: "hi" }, { Authorization: `Bearer ${token}` });
  assert.equal(after.status, 404);
  assert.deepEqual(after.body, { ok: false, error: "not found" });
});

test("2.2 join route: avatar too large or not PNG/JPEG", async () => {
  const boss = await box("maya", maya);
  await boss.service.create({ slug: "acme", charter: "Acme" });
  const code1 = parseInviteLink((await boss.service.invite("acme")).body.link).code;
  const big = { mime: "image/jpeg", base64: Buffer.alloc(MAX_AVATAR_BYTES + 10).toString("base64") };
  assert.equal((await boss.call("POST", "/api/teams/join", { code: code1, ...sam, avatar: big })).status, 413);
  const gif = { mime: "image/gif", base64: PNG.base64 };
  assert.equal((await boss.call("POST", "/api/teams/join", { code: code1, ...sam, avatar: gif })).status, 400);
});

test("2.3 localhost-only routes reject the public host path", async () => {
  const boss = await box("maya", maya);
  assert.equal((await boss.call("GET", "/api/team-local")).status, 200);
  assert.equal((await boss.call("GET", "/api/team-local", null, { "X-Forwarded-For": "203.0.113.9" })).status, 403);
  assert.equal((await boss.call("POST", "/api/team-local/create", { slug: "x", charter: "y" }, { "X-Forwarded-Host": "example-box.box.joshu.me" })).status, 403);
});

test("2.4 the team boss texts its owner about each join", async () => {
  const { boss } = await twoBoxes();
  assert.equal(boss.sent.length, 1);
  assert.equal(boss.sent[0].sms, "Sam's Joshu (Otto) joined the studio team.");
});

test("2.4b the join answer does not wait for the text to the owner", async () => {
  const boss = await box("maya", maya);
  await boss.service.create({ slug: "acme", charter: "Acme" });
  const code = parseInviteLink((await boss.service.invite("acme")).body.link).code;
  // The owner text channel can wait 45 s for an SMS delivery receipt; the member box waits 15 s.
  boss.service.deps.sendText = (input) => {
    boss.sent.push(input);
    return new Promise(() => {});
  };
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ status: "no answer after 2 s" }), 2_000).unref());
  const joined = await Promise.race([boss.call("POST", "/api/teams/join", { code, ...sam }), timeout]);
  assert.equal(joined.status, 201);
  assert.equal(boss.sent.length, 1);
});

test("2.5 invite page shows no team data", async () => {
  const { boss } = await twoBoxes();
  const link = (await boss.service.invite("studio")).body.link;
  for (const url of [link, `${boss.base}/teams/join/NotARealCodeAtAll123`]) {
    const res = await fetch(url);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Joshu team invite/);
    for (const secret of ["studio", "Client work", "Maya", "Mina", "Otto"]) assert.ok(!html.includes(secret), `page shows ${secret}`);
  }
});

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

test("3.1 join writes Teams files, keeps the member token out of the files root, sets up the box", async () => {
  const { member } = await twoBoxes();
  const m = await member.memberships.find("studio");
  assert.equal(m.isBoss, false);
  const charter = await readFile(path.join(member.filesRoot, "Teams/studio/charter.md"), "utf8");
  assert.match(charter, /Client work/);
  assert.match(await readFile(path.join(member.filesRoot, "Teams/studio/notes.md"), "utf8"), /Team notes: studio/);
  for (const file of await filesUnder(member.filesRoot)) assert.ok(!(await readFile(file, "utf8")).includes(m.token), `token in ${file}`);
  assert.equal(member.kanban[0].action, "ensure_board");
  assert.equal(member.kanban[0].board, "team-studio");
  assert.equal(member.teamsChanged, 1);
});

test("3.1 local team slug collision gets -2; leave deletes the member token", async () => {
  const { boss, member } = await twoBoxes();
  const boss2 = await box("lee", lee);
  await boss2.service.create({ slug: "studio", charter: "Another studio" });
  const joined = await member.service.join({ inviteLink: (await boss2.service.invite("studio")).body.link });
  assert.equal(joined.body.team.slug, "studio-2");
  assert.equal(joined.body.team.remoteSlug, "studio");
  assert.equal((await member.service.leave("studio-2")).status, 200);
  assert.equal(await member.memberships.find("studio-2"), undefined);
  assert.ok(member.cron.some((c) => c.action === "remove"));
  assert.ok(boss);
});

test("3.2 the team boss reads and posts through the same membership code", async () => {
  const { boss, member } = await twoBoxes();
  assert.equal((await boss.service.post("studio", { text: "Hello team" })).status, 201);
  assert.equal((await member.service.post("studio", { text: "Hello boss" })).status, 201);
  const read = await boss.service.read("studio");
  assert.deepEqual(read.body.room.entries.map((e) => e.text), ["Hello team", "Hello boss"]);
  const labels = read.body.room.members.map((x) => x.label);
  assert.deepEqual(labels, ["Maya's Joshu (Mina)", "Sam's Joshu (Otto)"]);
  // The cursor moves only with advance.
  const first = await member.service.read("studio", { advance: true });
  assert.equal(first.body.room.entries.length, 2);
  await boss.service.post("studio", { text: "Third" });
  const next = await member.service.read("studio", { advance: true });
  assert.deepEqual(next.body.room.entries.map((e) => e.text), ["Third"]);
});

test("3.3 a new team charter reaches charter.md at the next read", async () => {
  const { boss, member } = await twoBoxes();
  assert.equal((await boss.service.setCharter("studio", "Client work. Mondays and Thursdays.")).status, 200);
  await member.service.read("studio");
  assert.match(await readFile(path.join(member.filesRoot, "Teams/studio/charter.md"), "utf8"), /Mondays and Thursdays/);
});

test("unreachable and rejected team boss", async () => {
  const { boss, member } = await twoBoxes();
  const m = await member.memberships.find("studio");
  await member.memberships.update("studio", { bossUrl: "http://127.0.0.1:1/joshu" });
  const down = await member.service.read("studio");
  assert.equal(down.status, 502);
  assert.ok((await member.memberships.find("studio")).unreachableSince);
  await member.memberships.update("studio", { bossUrl: m.bossUrl });
  assert.equal((await member.service.read("studio")).status, 200);
  assert.equal((await member.memberships.find("studio")).unreachableSince, undefined);
  await boss.service.removeMember("studio", m.memberId);
  const rejected = await member.service.read("studio");
  assert.equal(rejected.status, 404);
  assert.match(rejected.body.error, /rejected the member token/);
});


// —— Group 4: team MCP, team_tell_owner, resolve turn, Hermes config ——
const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function mcpClient(url) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

test("4.1 team MCP at /team/acme/mcp works only on team acme; 4.5 chat tools on /mcp", async () => {
  const boss = await box("maya", maya);
  await boss.service.create({ slug: "acme", charter: "Acme Ops" });
  await boss.service.create({ slug: "family", charter: "Family" });
  const port = await freePort();
  const child = spawn(process.execPath, ["scripts/joshu-connectors-mcp-http-server.mjs"], {
    env: { ...process.env, JOSHU_CONNECTORS_API_BASE: boss.base, JOSHU_CONNECTORS_MCP_PORT: String(port), JOSHU_CONNECTORS_MCP_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    for (let i = 0; i < 50; i += 1) {
      const up = await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const team = await mcpClient(`http://127.0.0.1:${port}/team/acme/mcp`);
    const tools = (await team.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["team_blockers", "team_card", "team_commit", "team_post", "team_read", "team_tell_owner"]);
    const posted = await team.callTool({ name: "mcp_joshu_team_acme_team_post", arguments: { text: "Hello acme" } });
    assert.ok(!posted.isError, JSON.stringify(posted));
    await team.callTool({ name: "team_card", arguments: { op: "project_add", code: "OPS", name: "Ops" } });
    await team.callTool({ name: "team_card", arguments: { op: "create", title: "Fix the router", project: "OPS" } });
    const read = JSON.parse((await team.callTool({ name: "team_read", arguments: {} })).content[0].text);
    assert.equal(read.team, "acme");
    assert.ok(read.entries.some((e) => e.text === "Hello acme" && e.author === "Maya's Joshu (Mina)"));
    assert.equal(read.cards[0].id, "OPS-1");
    assert.ok(!JSON.stringify(read).includes("base64"), "team_read must not return avatar bytes");
    // team_post passes the card ids and the team question of a reply of the owner.
    const postTool = (await team.listTools()).tools.find((t) => t.name === "team_post");
    assert.deepEqual(Object.keys(postTool.inputSchema.properties).sort(), ["cards", "inReplyTo", "ownerTask", "text"]);
    const withCard = await team.callTool({ name: "team_post", arguments: { text: "I took this one.", cards: ["OPS-1"], ownerTask: "t_a0000009" } });
    assert.ok(!withCard.isError, JSON.stringify(withCard));
    const last = (await boss.service.read("acme")).body.room.entries.at(-1);
    assert.deepEqual([last.cards[0].id, last.viaOwner], ["OPS-1", true]);
    // team_blockers: blocked tasks of the project boards and of this team's board, never of another team's board.
    boss.tasks.push(
      { task_id: "t_b1000001", board: "project-harbor", title: "Answer Harbor", status: "blocked", block_kind: null, block_reason: "awaiting the price list from Sam" },
      { task_id: "t_b1000002", board: "team-acme", title: "Brief", status: "blocked", block_kind: "needs_input", block_reason: "Maya's OK" },
      { task_id: "t_b1000003", board: "team-family", title: "Pickup", status: "blocked", block_kind: null, block_reason: "son is sick" },
      { task_id: "t_b1000004", board: "project-harbor", title: "Invoice", status: "ready", block_kind: null },
    );
    const blockers = JSON.parse((await team.callTool({ name: "team_blockers", arguments: {} })).content[0].text);
    assert.deepEqual(blockers.tasks.map((t) => [t.taskId, t.board]), [["t_b1000001", "project-harbor"], ["t_b1000002", "team-acme"]]);
    assert.equal(blockers.tasks[0].blockReason, "awaiting the price list from Sam");
    assert.ok(!JSON.stringify(blockers).includes("son is sick"), "team_blockers must not show the team board of another team");
    const family = await boss.service.read("family");
    assert.equal(family.body.room.entries.length, 0, "team room family must not change");
    assert.equal(family.body.room.cards.length, 0);
    await team.close();

    const chat = await mcpClient(`http://127.0.0.1:${port}/mcp`);
    const names = (await chat.listTools()).tools.map((t) => t.name);
    for (const t of ["team_list", "team_create", "team_invite", "team_join", "team_leave", "team_remove_member", "team_set_charter"]) {
      assert.ok(names.includes(t), `connectors MCP lists ${t}`);
    }
    const listed = JSON.parse((await chat.callTool({ name: "team_list", arguments: {} })).content[0].text);
    assert.deepEqual(listed.teams.map((t) => t.slug).sort(), ["acme", "family"]);
    assert.ok(!JSON.stringify(listed).includes('"token"'), "team_list must not show member tokens");
    const invite = JSON.parse((await chat.callTool({ name: "team_invite", arguments: { team: "acme" } })).content[0].text);
    assert.ok(parseInviteLink(invite.link));
    await chat.close();
  } finally {
    child.kill();
  }
});

test("4.2 team_tell_owner: names the team, Ref line with a task id, 3 each day", async () => {
  const { boss } = await twoBoxes();
  const before = boss.sent.length; // the join text does not count
  const info = await boss.service.tellOwner("studio", { text: "Otto sent the Q4 price list. I added it to the Harbor project." });
  assert.equal(info.status, 200);
  const infoText = boss.sent.at(-1).sms;
  assert.match(infoText, /^\[Team studio\] /);
  assert.ok(!infoText.includes("Ref:"));
  assert.equal(boss.questions.length, 0);
  const ask = await boss.service.tellOwner("studio", { text: "Sam needs your OK on the price list. Approve or hold?", taskId: "t_77aa55cc" });
  assert.equal(ask.status, 200);
  assert.match(boss.sent.at(-1).sms, /\nRef: pj\/t_77aa55cc$/);
  assert.equal(boss.questions[0].board, "team-studio");
  assert.equal(boss.questions[0].taskId, "t_77aa55cc");
  assert.equal((await boss.service.tellOwner("studio", { text: "third" })).status, 200);
  const fourth = await boss.service.tellOwner("studio", { text: "fourth" });
  assert.equal(fourth.status, 429);
  assert.equal(boss.sent.length, before + 3);
  const saved = clock;
  clock = new Date(saved.getTime() + DAY);
  try {
    assert.equal((await boss.service.tellOwner("studio", { text: "next day" })).status, 200);
  } finally {
    clock = saved;
  }
});

test("4.2 a team text with a Ref line does not count against the nudge cap, and its reply finds the board", () => {
  let state = factoryProactiveState("2026-10-08");
  state = recordOwnerQuestionText(state, { taskId: "t_77aa55cc", board: "team-studio", sentAt: clock.toISOString(), channel: "sms" });
  assert.equal(state.sentCount, 0);
  assert.equal(state.lastNudge.board, "team-studio");
  assert.ok(state.nudgedTaskIds.includes("t_77aa55cc"), "the hourly sweep does not nudge it again today");
  // A later nudge on another board must not send the reply about t_77aa55cc to that board.
  state = { ...state, lastNudge: { taskId: "t_0000aaaa", board: "project-harbor", sentAt: clock.toISOString(), channel: "sms" } };
  assert.equal(boardForTaskRef(state, "t_77aa55cc"), "team-studio");
  assert.equal(boardForTaskRef(state, "t_0000aaaa"), "project-harbor");
});

test("4.3 the resolve turn of a team board loads skill team-standup", () => {
  assert.equal(skillForBoard("team-studio"), "team-standup");
  const msg = buildProactiveResolveSystemMessage({ taskId: "t_77aa55cc", board: "team-studio" }, "OK, but say Thursday");
  assert.ok(msg.content.includes("skill_view('team-standup')"));
});

test("6.1 the team stand-up job: skill, pinned model, raw toolsets, schedule, owner time zone", async () => {
  const { member } = await twoBoxes();
  const job = member.cron.find((c) => c.action === "create");
  assert.equal(job.name, "Team stand-up: studio");
  assert.deepEqual(job.skills, ["team-standup"]);
  assert.equal(job.model, "test/model");
  // no_mcp: without the named servers in the Hermes config, Hermes adds no MCP server instead of all.
  assert.deepEqual(job.enabled_toolsets, ["file", "kanban", "gbrain", "joshu_team_studio", "no_mcp"]);
  assert.ok(job.enabled_toolsets.every((t) => !t.startsWith("mcp-")), "raw MCP server names only");
  assert.equal(job.schedule, "45 8 * * 1-5");
  assert.equal(job.deliver, "local");
  assert.equal(job.workdir, member.filesRoot);
  assert.match(job.prompt, /team-standup/);
  // The file tool resolves a relative path from the Desktop, so the prompt names the full path of the team folder.
  assert.ok(job.prompt.includes(`${path.join(member.filesRoot, "Teams", "studio")}/`), job.prompt);
  assert.equal(member.tzSyncs, 1);
  assert.equal((await member.memberships.find("studio")).cronJobId, "job-1");
  const custom = await box("lee", lee);
  await custom.service.create({ slug: "family", charter: "Family", schedule: "30 7 * * *" });
  assert.equal(custom.cron.find((c) => c.action === "create").schedule, "30 7 * * *");
});

test("6.2 a team stand-up made by an older Joshu gets the current prompt", async () => {
  const { member } = await twoBoxes();
  const out = await member.service.syncStandupPrompts();
  assert.deepEqual(out, [{ slug: "studio", updated: true }]);
  const update = member.cron.find((c) => c.action === "update");
  assert.equal(update.job_id, "job-1");
  assert.ok(update.prompt.includes(path.join(member.filesRoot, "Teams", "studio")), update.prompt);
  assert.deepEqual(Object.keys(update).sort(), ["action", "job_id", "prompt"], "only the prompt changes");
});

test("6.2 boot sync: an existing team stand-up without no_mcp gets the current toolsets once", async () => {
  const { member } = await twoBoxes();
  member.jobToolsets = ["file", "kanban", "gbrain", "joshu_team_studio"];
  member.cron.length = 0;
  assert.deepEqual(await member.service.syncStandupJobs(), [{ slug: "studio", updated: true }]);
  const update = member.cron.find((c) => c.action === "update");
  assert.equal(update.job_id, "job-1");
  assert.deepEqual(update.enabled_toolsets, ["file", "kanban", "gbrain", "joshu_team_studio", "no_mcp"]);
  member.jobToolsets = update.enabled_toolsets;
  member.cron.length = 0;
  assert.deepEqual(await member.service.syncStandupJobs(), []);
  assert.ok(!member.cron.some((c) => c.action === "update"), "a current job is not updated again");
});

test("4.4 Hermes config: exactly one team MCP server for each team", () => {
  const servers = { gbrain: { url: "x" }, joshu_connectors: { url: "http://127.0.0.1:8795/mcp" }, joshu_team_old: { url: "y" } };
  assert.equal(syncTeamMcpServers(servers, ["acme", "family-2"], "http://127.0.0.1:8795/mcp"), true);
  assert.deepEqual(Object.keys(servers).filter((k) => k.startsWith("joshu_team_")).sort(), ["joshu_team_acme", "joshu_team_family_2"]);
  assert.equal(servers.joshu_team_acme.url, "http://127.0.0.1:8795/team/acme/mcp");
  assert.equal(servers.joshu_team_family_2.url, "http://127.0.0.1:8795/team/family-2/mcp");
  assert.ok(servers.gbrain && servers.joshu_connectors);
  assert.equal(syncTeamMcpServers(servers, ["acme", "family-2"], "http://127.0.0.1:8795/mcp"), false);
});


test("team_commit: the Kanban task has the format, the origin line, and the block kind; the card follows", async () => {
  const { boss, member } = await twoBoxes();
  await boss.service.card("studio", { op: "project_add", code: "HAR", name: "Harbor rebrand" });
  const memberId = (await member.memberships.find("studio")).memberId;
  await boss.service.card("studio", { op: "create", title: "Final logo files", project: "HAR", doer: memberId });
  const ready = await member.service.commit("studio", { card: "HAR-1", title: "Final logo files", details: "Send the files by Wed 12:00.", askedBy: "Maya's Joshu (Mina)", messageId: "m_3" });
  assert.equal(ready.status, 201, JSON.stringify(ready.body));
  const create = member.kanban.find((k) => k.action === "create");
  assert.equal(create.board, "team-studio");
  assert.match(create.body, /^kind: team_commitment\nteam: studio\nteam_card: HAR-1\nasked_by: Maya's Joshu \(Mina\)\nmessage_id: m_3\norigin: team room/);
  assert.deepEqual(create.skills, ["team-standup"]);
  assert.ok(!member.kanban.some((k) => k.action === "block"), "a ready commitment is not blocked");
  // needsOwner: blocked with needs_input, and the card waits on a person.
  await boss.service.card("studio", { op: "create", title: "Review the contract", project: "HAR", doer: memberId });
  const needs = await member.service.commit("studio", { card: "HAR-2", title: "Review the contract", details: "Sam reviews by Friday.", needsOwner: true, waitingOn: "Sam's OK" });
  assert.equal(needs.status, 201);
  const block = member.kanban.find((k) => k.action === "block");
  assert.equal(block.kind, "needs_input");
  const cards = (await boss.service.read("studio")).body.room.cards;
  assert.equal(cards.find((c) => c.id === "HAR-2").state, "waiting");
  assert.equal(cards.find((c) => c.id === "HAR-2").waitingOn, "Sam's OK");
  assert.equal((await member.service.commit("studio", { card: "nope", title: "x", details: "y" })).status, 400);
});

test("team_tell_owner ask=true: a team_question task blocked with needs_input, then the Ref line", async () => {
  const { boss } = await twoBoxes();
  boss.kanban.length = 0;
  const out = await boss.service.tellOwner("studio", { text: "I'd like to tell the studio team about the logo deadline. OK?", ask: true, draft: "@Otto, can Sam send the final files by Wed 12:00?" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const create = boss.kanban.find((k) => k.action === "create");
  assert.match(create.body, /^kind: team_question\nteam: studio\nquestion: draft\n/);
  assert.match(create.body, /## Draft\n\n@Otto, can Sam send/);
  assert.equal(boss.kanban.find((k) => k.action === "block").kind, "needs_input");
  assert.match(out.body.taskId, /^t_[0-9a-f]{8}$/);
  assert.ok(boss.sent.at(-1).sms.endsWith(`Ref: pj/${out.body.taskId}`));
  assert.match(boss.sent.at(-1).sms, /Ref: pj\//);
  assert.equal(boss.questions.at(-1).board, "team-studio");
});


test("6.3 HERMES.md has the Multiplayer teams section", () => {
  const md = buildHermesContextMarkdown({ ownerName: "Maya", assistantName: "Mina" });
  assert.match(md, /## Multiplayer teams/);
  for (const tool of ["team_create", "team_invite", "team_join", "team_leave", "team_remove_member", "team_set_charter"]) assert.ok(md.includes(tool), tool);
  assert.match(md, /confirm=false/);
  assert.match(md, /Teams\/<team>\/notes\.md/);
  assert.match(md, /skill \*\*team-standup\*\*/);
});


test("parse a team task body", () => {
  const parsed = TeamService.parseTeamTaskBody("kind: team_question\nteam: studio\nquestion: draft\norigin: team room\n\nOK?\n\n## Draft\n\nLine one.\nLine two (HAR-3).\n");
  assert.equal(parsed.kind, "team_question");
  assert.equal(parsed.question, "draft");
  assert.equal(parsed.draft, "Line one.\nLine two (HAR-3).");
  assert.equal(parsed.text, "OK?");
});

test("member box: card copies and the read position reach the team boss over HTTP", async () => {
  const { boss, member } = await twoBoxes();
  const bossId = (await boss.memberships.find("studio")).memberId;
  const memberId = (await member.memberships.find("studio")).memberId;
  await boss.service.card("studio", { op: "project_add", code: "HAR", name: "Harbor rebrand" });
  await boss.service.card("studio", { op: "create", title: "Q4 price list", project: "HAR", doer: memberId });
  const posted = await member.service.post("studio", { text: "I took this one.", cards: ["HAR-1"] });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  await member.service.read("studio", { advance: true });
  const read = await boss.service.read("studio");
  const msg = read.body.room.entries.find((e) => e.kind === "message");
  assert.equal(msg.cards[0].id, "HAR-1");
  assert.equal(read.body.room.seen[memberId], msg.id);
  assert.equal(read.body.room.seen[bossId], undefined);
});

test("7.1 view route: room, avatars, questions, notes; nothing written under <files>; desktop gate", async () => {
  const { boss, member } = await twoBoxes();
  await boss.service.post("studio", { text: "Morning" });
  await member.service.tellOwner("studio", { text: "OK to send this?", ask: true, draft: "@Mina, the files are ready." });
  const before = await Promise.all((await filesUnder(member.filesRoot)).map(async (f) => [f, await readFile(f, "utf8")]));
  const res = await member.call("GET", "/api/teams/studio/view");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.room.entries.map((e) => e.text), ["Morning"]);
  assert.equal(res.body.room.members[0].avatar.mime, "image/png", "the boss avatar reaches the member app");
  assert.equal(res.body.questions.length, 1);
  assert.equal(res.body.questions[0].draft, "@Mina, the files are ready.");
  assert.match(res.body.notes, /Team notes: studio/);
  const after = await Promise.all((await filesUnder(member.filesRoot)).map(async (f) => [f, await readFile(f, "utf8")]));
  assert.deepEqual(after, before, "the view writes nothing under <files>");
  const list = await member.call("GET", "/api/teams/app");
  assert.equal(list.body.teams[0].openQuestions, 1);
  assert.equal((await member.call("GET", "/api/teams/studio/view", null, { "X-Forwarded-For": "203.0.113.9" })).status, 403);
  // Unreachable team boss: status, but the local data is still there.
  await member.memberships.update("studio", { bossUrl: "http://127.0.0.1:1/joshu" });
  const down = await member.call("GET", "/api/teams/studio/view");
  assert.equal(down.status, 200);
  assert.equal(down.body.room, undefined);
  assert.match(down.body.roomError, /has not answered since/);
  assert.equal(down.body.questions.length, 1);
  assert.match(down.body.notes, /Team notes/);
});

test("7.2 approve route: only a needs_input task of the team board, then the reply path with OK", async () => {
  const { member } = await twoBoxes();
  const asked = await member.service.tellOwner("studio", { text: "OK?", ask: true, draft: "Ready." });
  const taskId = asked.body.taskId;
  const ok = await member.call("POST", `/api/teams/studio/drafts/${taskId}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(member.resolved, [{ taskId, board: "team-studio", body: "OK" }]);
  // A task on another board, or a task that does not wait for the owner, is rejected.
  member.tasks.push({ task_id: "t_00bbccdd", board: "project-harbor", status: "blocked", block_kind: "needs_input" });
  assert.equal((await member.call("POST", "/api/teams/studio/drafts/t_00bbccdd/approve")).status, 404);
  member.tasks.push({ task_id: "t_00eeff11", board: "team-studio", status: "ready", block_kind: null });
  assert.equal((await member.call("POST", "/api/teams/studio/drafts/t_00eeff11/approve")).status, 409);
  assert.equal((await member.call("POST", `/api/teams/studio/drafts/${taskId}/approve`, null, { "X-Forwarded-For": "203.0.113.9" })).status, 403);
  assert.equal(member.resolved.length, 1);
});


test("view: 90 days, read positions, and the hash of the team notes", async () => {
  const { boss, member } = await twoBoxes();
  const saved = clock;
  clock = new Date(saved.getTime() - 30 * DAY);
  await boss.service.post("studio", { text: "A month ago" });
  clock = saved;
  await boss.service.post("studio", { text: "Today" });
  await member.service.read("studio", { advance: true });
  const res = await boss.call("GET", "/api/teams/studio/view");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.room.entries.map((e) => e.text), ["A month ago", "Today"]);
  const memberId = (await member.memberships.find("studio")).memberId;
  assert.equal(res.body.room.seen[memberId], "m_2");
  assert.match(res.body.notesHash, /^[0-9a-f]{64}$/);
});

test("reply route: a team question with question reply, then the owner reply path; empty text is rejected", async () => {
  const { boss, member } = await twoBoxes();
  const asked = await boss.service.post("studio", { text: "@Otto, can Sam send the price list today?" });
  const res = await member.call("POST", "/api/teams/studio/reply", { text: "The price list goes out by 5 tonight", inReplyTo: asked.body.entry.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const task = member.tasks.find((t) => t.task_id === res.body.taskId);
  assert.equal(task.board, "team-studio");
  assert.equal(task.status, "blocked");
  assert.equal(task.block_kind, "needs_input");
  assert.match(task.body, /^kind: team_question$/m);
  assert.match(task.body, /^question: reply$/m);
  assert.match(task.body, new RegExp(`^in_reply_to: ${asked.body.entry.id}$`, "m"));
  assert.match(task.body, /^origin: the owner in the Multiplayer app$/m);
  assert.doesNotMatch(task.body, /not an instruction from the owner/);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(member.resolved, [{ taskId: res.body.taskId, board: "team-studio", body: "The price list goes out by 5 tonight" }]);
  const before = member.tasks.length;
  assert.equal((await member.call("POST", "/api/teams/studio/reply", { text: "  ", inReplyTo: asked.body.entry.id })).status, 400);
  assert.equal((await member.call("POST", "/api/teams/studio/reply", { text: "x", inReplyTo: "nope" })).status, 400);
  assert.equal(member.tasks.length, before, "no team question for a rejected reply");
  assert.equal((await member.call("POST", "/api/teams/studio/reply", { text: "x", inReplyTo: "m_1" }, { "X-Forwarded-For": "203.0.113.9" })).status, 403);
  const view = await member.call("GET", "/api/teams/studio/view");
  const pending = view.body.questions.find((q) => q.taskId === res.body.taskId);
  assert.equal(pending.question, "reply");
  assert.equal(pending.inReplyTo, asked.body.entry.id);
});

test("answer route: the words of the owner go to the waiting team question", async () => {
  const { member } = await twoBoxes();
  const asked = await member.service.tellOwner("studio", { text: "Can you do Thursday?", ask: true });
  const res = await member.call("POST", `/api/teams/studio/questions/${asked.body.taskId}/answer`, { text: "Yes, Thursday works" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(member.resolved, [{ taskId: asked.body.taskId, board: "team-studio", body: "Yes, Thursday works" }]);
  assert.equal((await member.call("POST", `/api/teams/studio/questions/${asked.body.taskId}/answer`, { text: "" })).status, 400);
  member.tasks.push({ task_id: "t_00eeff12", board: "team-studio", status: "ready", block_kind: null });
  assert.equal((await member.call("POST", "/api/teams/studio/questions/t_00eeff12/answer", { text: "x" })).status, 409);
});

test("notes route: save with the hash that the app read; 409 with the new text when the notes changed", async () => {
  const { member } = await twoBoxes();
  const view = await member.call("GET", "/api/teams/studio/view");
  const text = `${view.body.notes}\n- Do not share: my travel\n`;
  const saved = await member.call("PUT", "/api/teams/studio/notes", { text, baseHash: view.body.notesHash });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const file = path.join(member.filesRoot, "Desktop", "joshu's files", "Teams", "studio", "notes.md");
  const notesFile = (await filesUnder(member.filesRoot)).find((f) => f.endsWith(path.join("Teams", "studio", "notes.md")));
  assert.ok(notesFile, `notes.md under the files root (${file})`);
  assert.match(await readFile(notesFile, "utf8"), /Do not share: my travel/);
  // The companion writes the team notes before the owner saves again.
  const { writeFile: write } = await import("node:fs/promises");
  await write(notesFile, "Team notes changed by the companion\n");
  const stale = await member.call("PUT", "/api/teams/studio/notes", { text: "Mine", baseHash: saved.body.notesHash });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.notes, "Team notes changed by the companion\n");
  assert.equal(await readFile(notesFile, "utf8"), "Team notes changed by the companion\n");
  const again = await member.call("PUT", "/api/teams/studio/notes", { text: "Mine", baseHash: stale.body.notesHash });
  assert.equal(again.status, 200);
  assert.equal((await member.call("PUT", "/api/teams/studio/notes", { text: "x", baseHash: "" }, { "X-Forwarded-For": "203.0.113.9" })).status, 403);
});

test("team_post: 400 characters, card ids, and the reply flag of the owner", async () => {
  const { boss, member } = await twoBoxes();
  const long = await member.service.post("studio", { text: "x".repeat(401) });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /400 characters/);
  assert.equal((await member.service.post("studio", { text: "ok", ownerTask: "nope" })).status, 400);
  const posted = await member.service.post("studio", { text: "@Mina, Sam says the price list goes out by 5 tonight.", ownerTask: "t_a0000001" });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const msg = (await boss.service.read("studio")).body.room.entries.find((e) => e.kind === "message");
  assert.equal(msg.viaOwner, true);
  const complete = member.kanban.find((k) => k.action === "complete");
  assert.deepEqual([complete.board, complete.task_id], ["team-studio", "t_a0000001"], "the box completes the reply task after the post");
  assert.match(complete.comment, /Posted to team studio as m_\d+/);
});

test("9.1 integration: two boxes end to end over HTTP", async () => {
  const a = await box("a", maya);
  const b = await box("b", sam);
  assert.equal((await a.call("POST", "/api/team-local/create", { slug: "acme", charter: "Acme Ops. Weekdays." })).status, 201);
  const invite = await a.call("POST", "/api/team-local/acme/invite", {});
  assert.equal(invite.status, 201);
  const preview = await b.call("POST", "/api/team-local/preview", { inviteLink: invite.body.link });
  assert.equal(preview.body.charter, "Acme Ops. Weekdays.");
  assert.equal((await b.call("POST", "/api/team-local/join", { inviteLink: invite.body.link })).status, 201);
  assert.equal((await a.call("POST", "/api/team-local/acme/post", { text: "Hello from A" })).status, 201);
  assert.equal((await b.call("POST", "/api/team-local/acme/post", { text: "Hello from B" })).status, 201);
  for (const x of [a, b]) {
    const read = await x.call("GET", "/api/team-local/acme/read");
    assert.deepEqual(read.body.room.entries.map((e) => e.text), ["Hello from A", "Hello from B"]);
  }
  const bId = (await b.memberships.find("acme")).memberId;
  assert.equal((await a.call("POST", "/api/team-local/acme/remove-member", { memberId: bId })).status, 200);
  const rejected = await b.call("GET", "/api/team-local/acme/read");
  assert.equal(rejected.status, 404);
  assert.match(rejected.body.error, /rejected the member token/);
});

// —— Change boss-mode-promise-fixes: early team stand-up, waiting texts, texting preference ——
const at = (iso) => new Date(iso);
async function withClock(iso, fn) {
  const saved = clock;
  clock = at(iso);
  try {
    return await fn();
  } finally {
    clock = saved;
  }
}
const runs = (b) => b.cron.filter((c) => c.action === "run").length;

test("wake rules: mention, answer to an own message, card of the box; not own entries", () => {
  const room = {
    slug: "studio",
    charter: "",
    you: "m_me",
    projects: [],
    members: [
      { id: "m_me", ownerName: "Maya", companionName: "Mina", label: "", isBoss: true, active: true },
      { id: "m_b", ownerName: "Sam", companionName: "Otto", label: "", isBoss: false, active: true },
    ],
    cards: [
      { id: "HAR-4", title: "Q4 price list", project: "HAR", state: "done", doer: "m_b", asker: "m_me", createdAt: "", updatedAt: "" },
      { id: "HAR-5", title: "Other", project: "HAR", state: "todo", doer: "m_b", asker: "m_b", createdAt: "", updatedAt: "" },
    ],
    entries: [
      { kind: "message", id: "m_1", seq: 1, author: "m_b", at: "", text: "@mina can Maya look at this?" },
      { kind: "message", id: "m_2", seq: 2, author: "m_b", at: "", text: "Here it is", inReplyTo: "m_0" },
      { kind: "event", id: "m_3", seq: 3, author: "m_b", at: "", card: "HAR-4", text: "Otto moved HAR-4 to Done" },
      { kind: "event", id: "m_4", seq: 4, author: "m_b", at: "", card: "HAR-5", text: "Otto moved HAR-5 to Doing" },
      { kind: "message", id: "m_5", seq: 5, author: "m_b", at: "", text: "Nothing for anyone. @Minaret is not Mina." },
      { kind: "message", id: "m_6", seq: 6, author: "m_me", at: "", text: "@Mina note to self" },
    ],
  };
  assert.deepEqual(findWakeTriggers(room, ["m_0"]).map((e) => e.id), ["m_1", "m_2", "m_3"]);
  assert.deepEqual(findWakeTriggers(room, []).map((e) => e.id), ["m_1", "m_3"]);
  assert.deepEqual(findWakeTriggers(room, ["m_0"], 2).map((e) => e.id), ["m_3"]);
  assert.equal(inWakeWindow({ date: "2026-10-08", hour: 8, weekday: "Thursday" }), true);
  assert.equal(inWakeWindow({ date: "2026-10-08", hour: 19, weekday: "Thursday" }), false);
  assert.equal(inWakeWindow({ date: "2026-10-10", hour: 10, weekday: "Saturday" }), false);
});

test("early team stand-up: an answer to an ask starts the team stand-up once", async () => {
  await withClock("2026-10-08T10:00:00.000Z", async () => {
    const { boss, member } = await twoBoxes();
    const ask = await boss.service.post("studio", { text: "@Otto, can Sam send the Q4 price list today? (HAR-4)" });
    assert.equal(ask.status, 201);
    assert.deepEqual((await boss.memberships.find("studio")).ownMessageIds, [ask.body.entry.id]);
    // The member box wakes on the "@".
    await member.service.wakeCheck();
    assert.equal(runs(member), 1);
    await member.service.post("studio", { text: "Here is the Q4 price list: 40, 65, 90.", inReplyTo: ask.body.entry.id });
    await boss.service.wakeCheck();
    assert.equal(runs(boss), 1);
    // Same entries: no second early team stand-up, also after 20 minutes.
    await boss.service.wakeCheck();
    clock = at("2026-10-08T10:20:00.000Z");
    await boss.service.wakeCheck();
    assert.equal(runs(boss), 1);
  });
});

test("early team stand-up: not for an entry that does not need the box, not within 15 minutes", async () => {
  await withClock("2026-10-08T10:00:00.000Z", async () => {
    const { boss, member } = await twoBoxes();
    await member.service.post("studio", { text: "FYI: the printer is fixed." });
    await boss.service.wakeCheck();
    assert.equal(runs(boss), 0);
    boss.lastRunAt = "2026-10-08T09:50:00.000Z";
    await member.service.post("studio", { text: "@Mina, a question for Maya." });
    await boss.service.wakeCheck();
    assert.equal(runs(boss), 0);
    clock = at("2026-10-08T10:06:00.000Z");
    await boss.service.wakeCheck();
    assert.equal(runs(boss), 1);
  });
});

test("early team stand-up: not at night or on a weekend, then on the next workday", async () => {
  await withClock("2026-10-09T22:00:00.000Z", async () => {
    const { boss, member } = await twoBoxes();
    await member.service.post("studio", { text: "@Mina, can Maya do Monday?" });
    await boss.service.wakeCheck();
    clock = at("2026-10-10T10:00:00.000Z"); // Saturday
    await boss.service.wakeCheck();
    assert.equal(runs(boss), 0);
    clock = at("2026-10-12T08:05:00.000Z"); // Monday
    await boss.service.wakeCheck();
    assert.equal(runs(boss), 1);
  });
});

test("early team stand-up: at most 4 each day", async () => {
  await withClock("2026-10-08T08:00:00.000Z", async () => {
    const { boss, member } = await twoBoxes();
    for (let i = 0; i < MAX_EARLY_STANDUPS_PER_DAY + 1; i += 1) {
      await member.service.post("studio", { text: `@Mina, question ${i}` });
      await boss.service.wakeCheck();
      clock = new Date(clock.getTime() + 20 * 60_000);
    }
    assert.equal(runs(boss), MAX_EARLY_STANDUPS_PER_DAY);
  });
});

test("early team stand-up: a card event on a card of the box", async () => {
  await withClock("2026-10-08T11:00:00.000Z", async () => {
    const { boss, member } = await twoBoxes();
    const sam = (await member.memberships.find("studio")).memberId;
    await boss.service.card("studio", { op: "project_add", code: "HAR", name: "Harbor rebrand" });
    await boss.service.card("studio", { op: "create", title: "Q4 price list", project: "HAR", doer: sam });
    await member.service.wakeCheck();
    assert.equal(runs(member), 1);
  });
});

test("waiting texts: a fourth draft waits in the Multiplayer app and goes out the next workday", async () => {
  await withClock("2026-10-08T12:00:00.000Z", async () => {
    const { boss } = await twoBoxes();
    for (const text of ["one", "two", "three"]) assert.equal((await boss.service.tellOwner("studio", { text })).status, 200);
    const sentBefore = boss.sent.length;
    const draft = await boss.service.tellOwner("studio", { text: "For the studio team I'd like to say: … Reply OK.", ask: true, draft: "@Otto, files by Wed?" });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.queued, true);
    const task = boss.tasks.find((t) => t.task_id === draft.body.taskId);
    assert.equal(task.status, "blocked");
    assert.equal(task.block_kind, "needs_input");
    assert.equal((await boss.service.view("studio")).body.questions.length, 1);
    await boss.service.wakeCheck();
    assert.equal(boss.sent.length, sentBefore);
    clock = at("2026-10-09T07:30:00.000Z");
    await boss.service.wakeCheck();
    assert.equal(boss.sent.length, sentBefore);
    clock = at("2026-10-09T08:10:00.000Z");
    await boss.service.wakeCheck();
    assert.equal(boss.sent.length, sentBefore + 1);
    assert.match(boss.sent.at(-1).sms, new RegExp(`Ref: pj/${draft.body.taskId}$`));
    assert.equal(boss.questions.at(-1).taskId, draft.body.taskId);
    const m = await boss.memberships.find("studio");
    assert.deepEqual(m.pendingTexts, []);
    assert.equal(m.tellOwnerCount, 1);
  });
});

test("waiting texts: no text when the owner already answered", async () => {
  await withClock("2026-10-08T12:00:00.000Z", async () => {
    const { boss } = await twoBoxes();
    for (const text of ["one", "two", "three"]) await boss.service.tellOwner("studio", { text });
    const draft = await boss.service.tellOwner("studio", { text: "OK?", ask: true, draft: "Ready." });
    Object.assign(boss.tasks.find((t) => t.task_id === draft.body.taskId), { status: "done", block_kind: null });
    const sentBefore = boss.sent.length;
    clock = at("2026-10-09T09:00:00.000Z");
    await boss.service.wakeCheck();
    assert.equal(boss.sent.length, sentBefore);
    assert.deepEqual((await boss.memberships.find("studio")).pendingTexts, []);
  });
});

test("team notes template: section Texts", () => {
  const notes = teamNotesTemplate("studio", "Mina");
  assert.match(notes, /^## Texts$/m);
  assert.match(notes, /only text me when somebody needs a decision from me/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
}
for (const server of servers) server.close();
await rm(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log(`all ${tests.length} tests passed`);
