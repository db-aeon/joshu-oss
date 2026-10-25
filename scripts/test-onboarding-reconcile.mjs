#!/usr/bin/env npx tsx
/**
 * Unit tests: onboarding prompt registry, predicates, proactive helpers.
 *
 * Usage: npm run test:onboarding-reconcile
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isVersionAtLeast,
  loadOnboardingPromptRegistry,
  parsePrompt,
  parseVersionParts,
} from "../src/onboarding/promptRegistry.js";
import {
  anyGoogleAccountConnected,
  calendarConnected,
  evaluateOnboardingPredicate,
  ownerCalledBox,
  ownerMobileConfigured,
  ownerProfileComplete,
  voicePinSet,
  workAccountConnected,
  workGmailConnected,
} from "../src/onboarding/promptPredicates.js";
import { toProactiveCandidate } from "../src/proactive/sweep.js";
import { takeSetupMention } from "../src/onboarding/setupMention.js";
import { RealtimeGoalBroker } from "../src/realtimeGoals/broker.js";
import {
  isOnboardingKanbanBody,
  isPromptSnoozed,
  parseOnboardingPromptIdFromBody,
  readOnboardingPromptState,
  writeOnboardingPromptState,
} from "../src/onboarding/promptState.js";
import { ONBOARDING_RANK_BOOST } from "../src/onboarding/onboardingProactive.js";
import { applyRankBoost } from "../src/proactive/prioritize.js";
import { skillForBoard } from "../src/proactive/resolveOwnerReply.js";
import { factoryProactiveState } from "../src/proactive/state.js";
import { applySentNudge } from "../src/proactive/tick.js";
import { sortHygieneCandidates } from "../src/proactive/hygienePrepare.js";
import {
  buildOnboardingTaskBody,
  reconcileOnboardingPrompt,
  upsertBlockedOnboardingTask,
} from "../src/onboarding/reconcileOnboardingBoard.js";

// version gating
{
  assert.deepEqual(parseVersionParts("0.1.45"), [0, 1, 45]);
  assert.equal(isVersionAtLeast("0.1.45", "0.1.45"), true);
  assert.equal(isVersionAtLeast("0.1.44", "0.1.45"), false);
  assert.equal(isVersionAtLeast("0.2.0", "0.1.45"), true);
}

// registry load (repo factory file)
{
  const registry = loadOnboardingPromptRegistry(process.cwd());
  assert.equal(registry.schemaVersion, 1);
  assert.ok(registry.prompts.length >= 2);
  assert.ok(registry.prompts.some((p) => p.id === "connect-work-gmail"));
  assert.ok(registry.prompts.some((p) => p.id === "owner-mobile-sms"));
}

// owner mobile predicate
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-onboard-"));
  const prevUser = process.env.JOSHU_AROZ_USER;
  const prevAroz = process.env.AROZ_DATA;
  process.env.JOSHU_AROZ_USER = "test@example.com";
  process.env.AROZ_DATA = dir;
  const telDir = path.join(dir, "files", "users", "test@example.com", ".joshu", "telephone");
  fs.mkdirSync(telDir, { recursive: true });
  fs.writeFileSync(
    path.join(telDir, "settings.json"),
    JSON.stringify({ ownerCaller: "+15551234567" }),
  );
  assert.equal(ownerMobileConfigured(dir), true);
  if (prevUser === undefined) delete process.env.JOSHU_AROZ_USER;
  else process.env.JOSHU_AROZ_USER = prevUser;
  if (prevAroz === undefined) delete process.env.AROZ_DATA;
  else process.env.AROZ_DATA = prevAroz;
  fs.rmSync(dir, { recursive: true, force: true });
}

// prompt state snooze
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-snooze-"));
  const prevUser = process.env.JOSHU_AROZ_USER;
  const prevAroz = process.env.AROZ_DATA;
  process.env.JOSHU_AROZ_USER = "test@example.com";
  process.env.AROZ_DATA = dir;
  const future = new Date(Date.now() + 86_400_000).toISOString();
  writeOnboardingPromptState(
    { schemaVersion: 1, prompts: { "owner-mobile-sms": { dismissedUntil: future } } },
    dir,
  );
  const state = readOnboardingPromptState(dir);
  assert.equal(isPromptSnoozed(state, "owner-mobile-sms"), true);
  if (prevUser === undefined) delete process.env.JOSHU_AROZ_USER;
  else process.env.JOSHU_AROZ_USER = prevUser;
  if (prevAroz === undefined) delete process.env.AROZ_DATA;
  else process.env.AROZ_DATA = prevAroz;
  fs.rmSync(dir, { recursive: true, force: true });
}

// kanban body helpers
{
  const body = "kind: onboarding\nprompt_id: connect-work-gmail\ndeep_link: Connectors";
  assert.equal(isOnboardingKanbanBody(body), true);
  assert.equal(parseOnboardingPromptIdFromBody(body), "connect-work-gmail");
}

// rank boost
{
  const boosted = applyRankBoost(
    {
      taskId: "t_x",
      board: "ea-onboarding",
      title: "Connect Gmail",
      status: "blocked",
      blockReason: "awaiting owner",
      rankScore: 200,
      rankSignals: {},
    },
    -ONBOARDING_RANK_BOOST,
  );
  assert.equal(boosted.rankScore, 200 - ONBOARDING_RANK_BOOST);
}

// onboarding nudge daily cap state
{
  let state = factoryProactiveState("2026-09-08");
  state = applySentNudge(
    state,
    {
      taskId: "t_ob",
      board: "ea-onboarding",
      sentAt: new Date().toISOString(),
      channel: "sms",
    },
    "2026-09-08",
  );
  assert.equal(state.lastOnboardingNudgeDate, "2026-09-08");
}

// resolve skill routing
{
  assert.equal(skillForBoard("ea-onboarding"), "ea-onboarding");
}

// hygiene sort excludes onboarding via prepare filter (body marker)
{
  const rows = sortHygieneCandidates([
    {
      board: "ea-onboarding",
      task_id: "t_1",
      title: "Connect Gmail",
      body: "kind: onboarding\nprompt_id: connect-work-gmail",
      block_reason: "awaiting owner",
      created_at_ms: 1000,
    },
    {
      board: "project-x",
      task_id: "t_2",
      title: "Follow up",
      body: "kind: mail_track",
      block_reason: "awaiting owner",
      created_at_ms: 2000,
    },
  ]);
  assert.equal(rows.length, 2);
}

// Requirement "Blocks on the owner set block kind needs_input" (change proactive-clarify-hardening, spec owner-nudge).
{
  const prompt = loadOnboardingPromptRegistry(process.cwd()).prompts[0];
  /** Fake Kanban bridge. `found` is the task that find_by_idempotency returns. */
  const fakeBridge = (found) => {
    const calls = [];
    const bridge = async (payload) => {
      calls.push(payload);
      if (payload.action === "find_by_idempotency") {
        return found ? { success: true, found: true, task: found } : { success: true, found: false };
      }
      if (payload.action === "create") return { success: true, task_id: "t_new" };
      return { success: true, task_id: payload.task_id };
    };
    return { bridge, calls };
  };

  // Scenario "Onboarding prompt": a new onboarding task is blocked with kind needs_input.
  {
    const fake = fakeBridge(null);
    const out = await upsertBlockedOnboardingTask(prompt, "/tmp/files", fake.bridge);
    assert.equal(out.created, true);
    const block = fake.calls.find((c) => c.action === "block");
    assert.equal(block?.kind, "needs_input");
    assert.equal(block?.task_id, "t_new");
  }

  // Scenario "Blocked onboarding task without a block kind": reconcile sets kind needs_input.
  {
    const fake = fakeBridge({ task_id: "t_old", status: "blocked", block_kind: null });
    await upsertBlockedOnboardingTask(prompt, "/tmp/files", fake.bridge);
    const update = fake.calls.find((c) => c.action === "update_block_reason");
    assert.equal(update?.kind, "needs_input");
    assert.equal(update?.task_id, "t_old");
    assert.equal(update?.reason, "awaiting owner");
  }

  // A blocked onboarding task that already has kind needs_input and the current how-to does not change.
  {
    const fake = fakeBridge({
      task_id: "t_ok",
      status: "blocked",
      block_kind: "needs_input",
      body: buildOnboardingTaskBody(prompt),
    });
    await upsertBlockedOnboardingTask(prompt, "/tmp/files", fake.bridge);
    assert.deepEqual(fake.calls.map((c) => c.action), ["find_by_idempotency"]);
  }

  // An onboarding task that is not blocked is blocked again with kind needs_input.
  {
    const fake = fakeBridge({ task_id: "t_ready", status: "ready", block_kind: null });
    await upsertBlockedOnboardingTask(prompt, "/tmp/files", fake.bridge);
    const block = fake.calls.find((c) => c.action === "block");
    assert.equal(block?.kind, "needs_input");
  }
}


// ---- Change owner-setup-board ----

/** Temporary owner files root. `files` maps paths under `.joshu/` to JSON content. */
function withOwnerFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-setup-"));
  const saved = {};
  const env = {
    JOSHU_AROZ_USER: "owner@example.com",
    AROZ_DATA: dir,
    JOSHU_REALTIME_GOALS_STATE_DIR: path.join(dir, "realtime-goals"),
    TWILIO_OWNER_CALLER: undefined,
    JOSHU_FILES_ROOT: undefined,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const joshu = path.join(dir, "files", "users", "owner@example.com", ".joshu");
  for (const [rel, content] of Object.entries(files)) {
    const file = rel.startsWith("realtime-goals/") ? path.join(dir, rel) : path.join(joshu, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(restore);
}

const fullProfile = {
  ownerName: "Sam Owner",
  timezone: "America/Los_Angeles",
  primaryWorkEmail: "sam@work.example",
};
const registry = (gmail = [], calendar = []) => ({
  gmail: { enabled: true, accounts: gmail.map((email, i) => ({ connectedAccountId: `g${i}`, accountKey: `g${i}`, email, enabled: true })) },
  googleCalendar: { enabled: true, accounts: calendar.map((email, i) => ({ connectedAccountId: `c${i}`, accountKey: `c${i}`, email, enabled: true })) },
  onenote: { enabled: true, accounts: [] },
});

// Task 2.1: registry parser (type, how-to, mention).
{
  const base = { id: "x", title: "X", introducedIn: "0.1.50", deepLink: "Welcome", completeWhen: "manual" };
  const howto = { why: "Why.", steps: ["Do it."], mention: "Do X." };
  // A required setup step without why, steps, or mention is rejected.
  assert.equal(parsePrompt({ ...base, type: "required", steps: ["a"], mention: "m" }), null);
  assert.equal(parsePrompt({ ...base, type: "required", why: "w", mention: "m" }), null);
  assert.equal(parsePrompt({ ...base, type: "required", why: "w", steps: ["a"] }), null);
  // The earlier format (field `required`, no `type`) still parses.
  const old = parsePrompt({ ...base, required: true, ...howto });
  assert.equal(old?.type, "required");
  assert.equal(old?.required, true);
  assert.equal(old?.mention, "Do X.");
  // A setup tip needs no mention, and has none.
  const tip = parsePrompt({ ...base, type: "tip", why: "w", steps: ["a"], showWhen: "anyGoogleAccountConnected" });
  assert.equal(tip?.type, "tip");
  assert.equal(tip?.required, false);
  assert.equal(tip?.mention, undefined);
  assert.equal(tip?.showWhen, "anyGoogleAccountConnected");
  // An unknown check is rejected.
  assert.equal(parsePrompt({ ...base, type: "tip", why: "w", steps: ["a"], showWhen: "nope" }), null);
}

// Task 2.3: the shipped setup steps.
{
  const prompts = loadOnboardingPromptRegistry(process.cwd()).prompts;
  const required = prompts.filter((p) => p.type === "required");
  assert.deepEqual(
    required.map((p) => p.id),
    ["owner-profile", "owner-mobile-sms", "connect-work-gmail", "connect-calendar"],
  );
  for (const p of required) assert.ok(p.mention && p.why && p.steps.length > 0, `${p.id} has a how-to and a mention`);
  const tips = prompts.filter((p) => p.type === "tip");
  assert.equal(tips.length, 5);
  for (const p of tips) assert.equal(p.mention, undefined);
  // Existing idempotency keys stay, so boxes keep their cards.
  assert.equal(prompts.find((p) => p.id === "connect-work-gmail")?.idempotencyKey, "onboarding:connect-work-gmail");
  assert.equal(prompts.find((p) => p.id === "owner-mobile-sms")?.idempotencyKey, "onboarding:owner-mobile-sms");
}

// Task 2.2: checks. Requirement "Each required setup step has a fixed done check".
await withOwnerFiles({}, async (dir) => {
  assert.equal(ownerProfileComplete(dir), false);
  assert.equal(await calendarConnected(dir), false);
  assert.equal(await workGmailConnected(dir), false);
  assert.equal(await anyGoogleAccountConnected(dir), false);
  assert.equal(await workAccountConnected(dir), false);
  assert.equal(voicePinSet(dir), false);
  assert.equal(await ownerCalledBox(dir), false);
  assert.equal(await evaluateOnboardingPredicate("manual", dir), false);
});

// Scenario "Profile without work email".
await withOwnerFiles(
  { "nylas/profile.json": { ownerName: "Sam Owner", timezone: "America/Los_Angeles" } },
  async (dir) => assert.equal(ownerProfileComplete(dir), false),
);
await withOwnerFiles({ "nylas/profile.json": { ...fullProfile, timezone: "Mars/Olympus" } }, async (dir) =>
  assert.equal(ownerProfileComplete(dir), false),
);

// Scenario "Connected account is not the work address": work mail connected is done, the work account tip is not.
await withOwnerFiles(
  {
    "nylas/profile.json": fullProfile,
    "connectors-registry.json": registry(["sam.personal@gmail.com"], ["sam.personal@gmail.com"]),
  },
  async (dir) => {
    assert.equal(ownerProfileComplete(dir), true);
    assert.equal(await workGmailConnected(dir), true);
    assert.equal(await calendarConnected(dir), true);
    assert.equal(await anyGoogleAccountConnected(dir), true);
    assert.equal(await workAccountConnected(dir), false);
  },
);
await withOwnerFiles(
  { "nylas/profile.json": fullProfile, "connectors-registry.json": registry([], ["SAM@work.example"]) },
  async (dir) => {
    assert.equal(await workGmailConnected(dir), false);
    assert.equal(await workAccountConnected(dir), true);
  },
);

// voicePinSet and ownerCalledBox.
await withOwnerFiles(
  {
    "telephone/settings.json": { pinHash: "scrypt$abc$def", pinLength: 4 },
    "realtime-goals/state.json": {
      goals: [],
      owner: {
        presence: {
          consecutiveMisses: 0,
          lastByChannel: { pstn_voice: { channel: "pstn_voice", at: "2026-10-08T02:26:06Z", origin: {} } },
        },
      },
    },
  },
  async (dir) => {
    assert.equal(voicePinSet(dir), true);
    assert.equal(await ownerCalledBox(dir), true);
  },
);

// Task 4.1: reconcile with a fake Kanban bridge.
{
  const prompts = loadOnboardingPromptRegistry(process.cwd()).prompts;
  const byId = (id) => prompts.find((p) => p.id === id);
  /** Fake bridge with one task per idempotency key. */
  const board = (tasks = {}) => {
    const calls = [];
    const bridge = async (payload) => {
      calls.push(payload);
      if (payload.action === "find_by_idempotency") {
        const task = tasks[payload.idempotency_key];
        return task ? { success: true, found: true, task } : { success: true, found: false };
      }
      if (payload.action === "create") return { success: true, task_id: `t_${payload.idempotency_key}` };
      return { success: true, task_id: payload.task_id };
    };
    return { bridge, calls };
  };
  const ctx = (dir, bridge) => ({
    projectRoot: dir,
    filesRoot: dir,
    promptState: { schemaVersion: 1, prompts: {} },
    bridge,
  });
  const run = async (dir, fake, ids) => {
    const out = {};
    for (const id of ids) out[id] = await reconcileOnboardingPrompt(byId(id), ctx(dir, fake.bridge));
    return out;
  };
  const required = ["owner-profile", "owner-mobile-sms", "connect-work-gmail", "connect-calendar"];

  // Scenario "Box where Welcome never finished": 4 open required setup cards, each an owner question.
  await withOwnerFiles({}, async (dir) => {
    const fake = board();
    const out = await run(dir, fake, required);
    for (const id of required) assert.equal(out[id].status, "open", id);
    const blocks = fake.calls.filter((c) => c.action === "block");
    assert.equal(blocks.length, 4);
    for (const block of blocks) {
      assert.equal(block.kind, "needs_input");
      assert.equal(block.reason, "awaiting owner");
    }
  });

  // Scenario "New box after Welcome without mobile and Gmail" (box darien on 2026-10-08).
  await withOwnerFiles(
    {
      "nylas/profile.json": fullProfile,
      "connectors-registry.json": registry([], ["sam.personal@gmail.com"]),
    },
    async (dir) => {
      const out = await run(dir, board(), required);
      assert.equal(out["owner-profile"].status, "skipped");
      assert.equal(out["connect-calendar"].status, "skipped");
      assert.equal(out["owner-mobile-sms"].status, "open");
      assert.equal(out["connect-work-gmail"].status, "open");
    },
  );

  // Scenario "Owner saves the mobile": the open card gets status done.
  await withOwnerFiles({ "telephone/settings.json": { ownerCaller: "+15551234567" } }, async (dir) => {
    const fake = board({ "onboarding:owner-mobile-sms": { task_id: "t_m", status: "blocked", block_kind: "needs_input" } });
    const out = await run(dir, fake, ["owner-mobile-sms"]);
    assert.equal(out["owner-mobile-sms"].status, "completed");
    assert.ok(fake.calls.some((c) => c.action === "complete" && c.task_id === "t_m"));
  });

  // Requirement "Each setup card carries a how-to": scenario "Card for work mail connected".
  {
    const body = buildOnboardingTaskBody(byId("connect-work-gmail"));
    assert.match(body, /^kind: onboarding$/m);
    assert.match(body, /^prompt_id: connect-work-gmail$/m);
    assert.match(body, /^type: required$/m);
    assert.match(body, /## Why\n.*only after your work account is connected/);
    assert.match(body, /## Steps\n1\. Open Connectors/);
    assert.match(body, /## Common mistakes\n- Signing in with a personal Gmail account/);
    assert.match(body, /^howto_version: [0-9a-f]{12}$/m);
  }

  // Scenario "Release changes a how-to": the open card gets the new body.
  await withOwnerFiles({}, async (dir) => {
    const fake = board({
      "onboarding:owner-mobile-sms": {
        task_id: "t_m",
        status: "blocked",
        block_kind: "needs_input",
        body: "kind: onboarding\nprompt_id: owner-mobile-sms\nhowto_version: old",
      },
    });
    await run(dir, fake, ["owner-mobile-sms"]);
    const setBody = fake.calls.find((c) => c.action === "set_body");
    assert.equal(setBody?.task_id, "t_m");
    assert.equal(setBody?.body, buildOnboardingTaskBody(byId("owner-mobile-sms")));
  });

  // Requirement "Setup tips are optional cards without reminders": scenario "Work account tip".
  await withOwnerFiles(
    { "nylas/profile.json": fullProfile, "connectors-registry.json": registry(["sam.personal@gmail.com"], []) },
    async (dir) => {
      const fake = board();
      const out = await run(dir, fake, ["tip-connect-work-account"]);
      assert.equal(out["tip-connect-work-account"].status, "open");
      const block = fake.calls.find((c) => c.action === "block");
      assert.equal(block?.reason, "optional setup tip");
      assert.equal(block?.kind, undefined, "a setup tip card has no block kind");
    },
  );
  // No Google account yet: the work account tip does not appear.
  await withOwnerFiles({ "nylas/profile.json": fullProfile }, async (dir) => {
    const fake = board();
    const out = await run(dir, fake, ["tip-connect-work-account"]);
    assert.equal(out["tip-connect-work-account"].status, "skipped");
    assert.ok(!fake.calls.some((c) => c.action === "create"));
  });
  // The owner then connects the work account: the reconcile completes the tip card.
  await withOwnerFiles(
    {
      "nylas/profile.json": fullProfile,
      "connectors-registry.json": registry(["sam.personal@gmail.com", "sam@work.example"], []),
    },
    async (dir) => {
      const fake = board({ "onboarding:tip-connect-work-account": { task_id: "t_tip", status: "blocked", block_kind: null } });
      const out = await run(dir, fake, ["tip-connect-work-account"]);
      assert.equal(out["tip-connect-work-account"].status, "completed");
    },
  );

  // Scenario "Owner completes a tip without a check": a done card is not opened again.
  await withOwnerFiles({}, async (dir) => {
    const fake = board({ "onboarding:tip-save-box-number": { task_id: "t_box", status: "done", block_kind: null } });
    const out = await run(dir, fake, ["tip-save-box-number"]);
    assert.equal(out["tip-save-box-number"].status, "skipped");
    assert.deepEqual(fake.calls.map((c) => c.action), ["find_by_idempotency"]);
  });

  // An open tip card keeps no block kind: the repair to needs_input applies only to required setup steps.
  await withOwnerFiles({}, async (dir) => {
    const prompt = byId("tip-save-box-number");
    const fake = board({
      "onboarding:tip-save-box-number": {
        task_id: "t_box",
        status: "blocked",
        block_kind: null,
        body: buildOnboardingTaskBody(prompt),
      },
    });
    await run(dir, fake, ["tip-save-box-number"]);
    assert.deepEqual(fake.calls.map((c) => c.action), ["find_by_idempotency"]);
  });

  // Task 4.2, scenario "Tip card and the proactive sweep": a tip card is never a nudge candidate.
  await withOwnerFiles({}, async (dir) => {
    const tipRow = {
      task_id: "t_tip",
      title: "Tip: set a keypad PIN for calls",
      status: "blocked",
      body: buildOnboardingTaskBody(byId("tip-voice-pin")),
      block_reason: "optional setup tip",
      block_kind: null,
      created_at_ms: Date.now(),
    };
    assert.equal(await toProactiveCandidate(tipRow, "ea-onboarding", dir, dir), null);
  });
}

// Task 5.1: requirement "The companion mentions open required setup once a day on each channel".
{
  const prevVersion = process.env.JOSHU_RELEASE_VERSION;
  process.env.JOSHU_RELEASE_VERSION = "0.1.50";
  const morning = new Date("2026-10-08T16:00:00Z"); // 09:00 in Los Angeles
  const evening = new Date("2026-10-09T02:00:00Z"); // 19:00 the same day in Los Angeles
  const nextDay = new Date("2026-10-09T16:00:00Z");
  // The setup steps file is read from the project root; the owner files come from the environment.
  const root = process.cwd();
  await withOwnerFiles({ "nylas/profile.json": fullProfile }, async () => {
    // Scenario "First web chat reply of the day": the first open required setup step is the owner mobile.
    const first = await takeSetupMention(root, "jchat", morning);
    assert.match(first ?? "", /add your mobile in the Telephone app/);
    // Scenario "Second web chat reply the same day".
    assert.equal(await takeSetupMention(root, "jchat", evening), null);
    // Scenario "Other channel the same day".
    assert.match((await takeSetupMention(root, "pstn_voice", evening)) ?? "", /Telephone/);
    // The next day, web chat gets the mention again.
    assert.ok(await takeSetupMention(root, "jchat", nextDay));
  });
  // Scenario "Setup done": no mention on any channel.
  await withOwnerFiles(
    {
      "nylas/profile.json": fullProfile,
      "telephone/settings.json": { ownerCaller: "+15551234567" },
      "connectors-registry.json": registry(["sam@work.example"], ["sam@work.example"]),
    },
    async () => {
      for (const channel of ["jchat", "sms", "pstn_voice", "slack", "telegram", "email"]) {
        assert.equal(await takeSetupMention(root, channel, morning), null, channel);
      }
    },
  );
  // A snoozed setup step is skipped: the mention names the next open required setup step.
  await withOwnerFiles(
    {
      "nylas/profile.json": fullProfile,
      "onboarding/prompt-state.json": {
        schemaVersion: 1,
        prompts: { "owner-mobile-sms": { dismissedUntil: "2099-01-01T00:00:00Z" } },
      },
    },
    async () => assert.match((await takeSetupMention(root, "sms", morning)) ?? "", /connect your work Gmail/),
  );
  if (prevVersion === undefined) delete process.env.JOSHU_RELEASE_VERSION;
  else process.env.JOSHU_RELEASE_VERSION = prevVersion;
}

// Task 5.2: the broker context carries the setup mention only for turns that answer the owner, once a day.
{
  const prevVersion = process.env.JOSHU_RELEASE_VERSION;
  process.env.JOSHU_RELEASE_VERSION = "0.1.50";
  await withOwnerFiles({ "nylas/profile.json": fullProfile }, async () => {
    const broker = new RealtimeGoalBroker(process.cwd());
    const sms = { channel: "sms", sessionKey: "sms:+15550001111", sessionId: "sms:+15550001111" };
    const call = { channel: "pstn_voice", sessionKey: "pstn:owner", sessionId: "CA0000000000000000000000" };
    // A caller without the flag (background job, call opener) gets no mention and uses up nothing.
    assert.doesNotMatch((await broker.buildHermesContextSnapshot(sms)) ?? "", /Setup reminder/);
    const first = await broker.buildHermesContextSnapshot(sms, { setupMention: true });
    assert.match(first ?? "", /Setup reminder: end your reply with this one sentence.*Telephone app/);
    assert.doesNotMatch(
      (await broker.buildHermesContextSnapshot(sms, { setupMention: true })) ?? "",
      /Setup reminder/,
    );
    assert.match((await broker.buildHermesContextSnapshot(call, { setupMention: true })) ?? "", /Setup reminder/);
  });
  if (prevVersion === undefined) delete process.env.JOSHU_RELEASE_VERSION;
  else process.env.JOSHU_RELEASE_VERSION = prevVersion;
}

console.log("test:onboarding-reconcile — all passed");
