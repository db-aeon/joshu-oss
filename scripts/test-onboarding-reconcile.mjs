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
  parseVersionParts,
} from "../src/onboarding/promptRegistry.js";
import { ownerMobileConfigured } from "../src/onboarding/promptPredicates.js";
import {
  isOnboardingKanbanBody,
  isPromptSnoozed,
  parseOnboardingPromptIdFromBody,
  readOnboardingPromptState,
  writeOnboardingPromptState,
} from "../src/onboarding/promptState.js";
import {
  isWithinOnboardingSetupWindow,
  ONBOARDING_RANK_BOOST,
} from "../src/onboarding/onboardingProactive.js";
import { applyRankBoost } from "../src/proactive/prioritize.js";
import { skillForBoard } from "../src/proactive/resolveOwnerReply.js";
import { factoryProactiveState } from "../src/proactive/state.js";
import { applySentNudge } from "../src/proactive/tick.js";
import { sortHygieneCandidates } from "../src/proactive/hygienePrepare.js";

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

// setup window
{
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  assert.equal(isWithinOnboardingSetupWindow(recent), true);
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  assert.equal(isWithinOnboardingSetupWindow(old), false);
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

console.log("test:onboarding-reconcile — all passed");
