#!/usr/bin/env npx tsx
/**
 * Unit tests: the mail workers preload only the mail worker skills (change mail-worker-skills).
 *
 * 1. Skill ea-mail-track has the filing rules, skill ea-mail-ingress has the ingress sections,
 *    and ea-playbook keeps only the sections of chat and crons. No section is in two skills.
 * 2. Mail ingress tasks preload ea-mail-ingress and ea-mail-track; mail track tasks preload
 *    ea-mail-track. The ingress task body does not ask for skill_view('ea-playbook').
 * 3. A handoff to a track that still preloads ea-playbook moves the track to ea-mail-track.
 * 4. The Kanban bridge action set_skills replaces the skills of a task (needs a local Hermes
 *    checkout, HERMES_AGENT_ROOT, default ~/.hermes/hermes-agent; skipped without one).
 *
 * Usage: npm run test:mail-worker-skills
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMailIngressTaskBody, handoffMailToTrackTask } from "../src/ea/mailCron.js";
import {
  EA_MAIL_INGRESS_SKILL,
  EA_MAIL_TRACK_SKILL,
  MAIL_INGRESS_TASK_SKILLS,
  MAIL_TRACK_TASK_SKILLS,
} from "../src/ea/mailTypes.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(root, "integrations/hermes/skills/executive-assistant");
const readSkill = (name) => readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
const headings = (text) =>
  text
    .split("\n")
    .filter((line) => /^#{2,4} /.test(line))
    .map((line) => line.replace(/^#+ /, ""));

// --- 1. Skill files -------------------------------------------------------------------------

const track = readSkill(EA_MAIL_TRACK_SKILL);
const ingress = readSkill(EA_MAIL_INGRESS_SKILL);
const playbook = readSkill("ea-playbook");

const TRACK_SECTIONS = [
  "Every run — read first",
  "Project files",
  "Link discipline (required)",
  "Mail attachments",
  "Canonical project matching",
  "Project reconcile",
  "Procedure",
  "After a handoff to a track",
  "Project boards — no scheduling sends",
  "MCP / Joshu API failures",
];
const INGRESS_SECTIONS = [
  "Mail ingress (ea-mail-ingress)",
  "Required order (do not reorder)",
  "Scheduling decision gate (MAIL INGRESS step 5)",
  "HITL defer triggers (path C)",
  "HITL defer — owner-review notes",
  "Confirmation / already-booked (path B)",
  "Core loop: one Triage stub → one project",
  "Classification guide",
  "Same-sender batch incoming notifications",
  "Project scope hygiene: strategic thinking vs. operational execution",
];
const PLAYBOOK_SECTIONS = [
  "In-chat idea capture (the owner riffing in conversation)",
  "On-demand situation report / agenda review",
  "Hermes skill-backed crons",
  "Summary email",
  "Escalation",
];

assert.deepEqual(TRACK_SECTIONS.filter((h) => !headings(track).includes(h)), [], "ea-mail-track sections");
assert.deepEqual(INGRESS_SECTIONS.filter((h) => !headings(ingress).includes(h)), [], "ea-mail-ingress sections");
assert.deepEqual(PLAYBOOK_SECTIONS.filter((h) => !headings(playbook).includes(h)), [], "ea-playbook sections");
for (const [name, text] of [
  ["ea-mail-track", track],
  ["ea-mail-ingress", ingress],
  ["ea-playbook", playbook],
]) {
  assert.match(text, new RegExp(`^name: ${name}$`, "m"), `${name} frontmatter name`);
}
const all = [...headings(track), ...headings(ingress), ...headings(playbook)].filter(
  (h) => !["Procedure"].includes(h),
);
const twice = all.filter((h, i) => all.indexOf(h) !== i);
assert.deepEqual(twice, [], "each section is in one skill only");
assert.ok(!headings(playbook).some((h) => h.startsWith("Triage drain")), "legacy Triage drain is gone");
assert.match(track, /split_from: ea-playbook/);
assert.match(ingress, /split_from: ea-playbook/);
assert.ok(!ingress.includes("skill_view('ea-playbook')`** — this section"), "no reload of ea-playbook");
assert.match(ingress, /Do \*\*not\*\* call `skill_view` for them/);
assert.match(playbook, /skill_view\('ea-mail-track'\)/, "ea-playbook points chat to ea-mail-track");
assert.match(playbook, /\*\*Old Kanban task:\*\*/, "ea-playbook tells an old mail task to load the new skills");
assert.ok(existsSync(path.join(skillsDir, "ea-mail-ingress/references/batch-incoming-notifications.md")));
// The mail worker skills are smaller than ea-playbook before the split (55,893 characters).
assert.ok(track.length < 15_000, `ea-mail-track is ${track.length} characters`);
assert.ok(track.length + ingress.length < 45_000, `ingress preload is ${track.length + ingress.length} characters`);

const enabled = readFileSync(path.join(root, "integrations/hermes/skills-enabled.yaml"), "utf8");
for (const name of [EA_MAIL_INGRESS_SKILL, EA_MAIL_TRACK_SKILL]) {
  assert.match(enabled, new RegExp(`^  - ${name}$`, "m"), `${name} is in skills-enabled.yaml`);
}

// --- 2. Preloaded skills of mail tasks and the ingress task body ---------------------------

assert.deepEqual(MAIL_INGRESS_TASK_SKILLS, ["ea-mail-ingress", "ea-mail-track"]);
assert.deepEqual(MAIL_TRACK_TASK_SKILLS, ["ea-mail-track"]);
const mailCron = readFileSync(path.join(root, "src/ea/mailCron.ts"), "utf8");
assert.equal((mailCron.match(/skills: MAIL_INGRESS_TASK_SKILLS,/g) ?? []).length, 1, "ingress create");
assert.equal((mailCron.match(/skills: MAIL_TRACK_TASK_SKILLS,/g) ?? []).length, 1, "track create");
assert.ok(!/skills: \[EA_PLAYBOOK_SKILL\]/.test(mailCron), "no mail task preloads ea-playbook");

const ingressBody = await buildMailIngressTaskBody(
  {
    filesRoot: "/tmp",
    provider: "gmail",
    threadId: "1a0fe82dba9c37ea",
    sourcePath: "connectors/mail/gmail/owner_at_example_com/threads/1a0fe82dba9c37ea.md",
    from: "Zachery Cooper <zach@example.com>",
    messageId: "1a0feafa20e78c71",
    classification: {
      category: "project_work",
      project_slug: "office-purchase-requests",
      is_new_track: false,
      reason: "test",
      scheduling_hint: false,
      authorization: { agent_authorized: false, scheduling_eligible: false, reason: "not_copied_or_delegated" },
    },
  },
  null,
);
assert.ok(!/skill_view\('?ea-playbook/.test(ingressBody), "ingress body does not load ea-playbook");
assert.ok(!/REQUIRED FIRST/.test(ingressBody));
assert.match(ingressBody, /Use the preloaded skill ea-mail-ingress/);
assert.match(ingressBody.split("\n").find((l) => l.startsWith("Order:")) ?? "", /^Order: \(1\) skills are preloaded, no skill_view \(2\) read_file/);

// --- 3. Handoff moves an old track off ea-playbook -----------------------------------------

function fakeBridge(skills) {
  const task = { task_id: "t_1", title: "Track", status: "blocked", body: "kind: mail_track", skills };
  const calls = [];
  const bridge = async (payload) => {
    calls.push(payload);
    switch (payload.action) {
      case "show":
        return { success: true, task: { ...task } };
      case "set_skills":
        task.skills = payload.skills;
        return { success: true };
      case "append_body":
      case "comment":
        return { success: true };
      case "unblock":
        task.status = "ready";
        return { success: true, action_taken: "unblocked" };
      default:
        throw new Error(`unexpected Kanban bridge action ${payload.action}`);
    }
  };
  return { bridge, task, calls };
}

const handoffOpts = {
  filesRoot: mkdtempSync(path.join(os.tmpdir(), "mail-worker-skills-")),
  projectSlug: "acme",
  taskId: "t_1",
  sourcePath: "connectors/mail/nylas/threads/x.md",
  messageId: "m_1",
  summary: "Riley replied.",
};
{
  const fake = fakeBridge(["ea-playbook"]);
  const result = await handoffMailToTrackTask(handoffOpts, fake.bridge);
  assert.equal(result.evaluation_queued, true);
  assert.deepEqual(fake.task.skills, ["ea-mail-track"], "old track now preloads ea-mail-track");
  const order = fake.calls.map((c) => c.action);
  assert.ok(order.indexOf("set_skills") < order.indexOf("unblock"), "skills change before the worker wakes");
}
{
  const fake = fakeBridge(["ea-mail-track"]);
  await handoffMailToTrackTask(handoffOpts, fake.bridge);
  assert.ok(!fake.calls.some((c) => c.action === "set_skills"), "a new track keeps its skills");
}
rmSync(handoffOpts.filesRoot, { recursive: true, force: true });

// --- 4. Kanban bridge set_skills on a local Hermes ------------------------------------------

const hermesRoot = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), ".hermes", "hermes-agent");
const python = [path.join(hermesRoot, "venv", "bin", "python"), path.join(hermesRoot, ".venv", "bin", "python")].find(
  (candidate) => existsSync(candidate),
);
if (!python) {
  console.log("test:mail-worker-skills — no Hermes checkout, bridge run test skipped");
} else {
  const home = mkdtempSync(path.join(os.tmpdir(), "joshu-mail-worker-skills-"));
  const bridgePath = path.join(root, "scripts/hermes-kanban-bridge.py");
  const bridge = (payload) => {
    const run = spawnSync(python, [bridgePath], {
      input: JSON.stringify(payload),
      env: { ...process.env, HERMES_AGENT_ROOT: hermesRoot, HERMES_KANBAN_HOME: home, HERMES_HOME: home },
      encoding: "utf8",
    });
    const line = run.stdout.trim().split("\n").pop() ?? "";
    assert.ok(line, `bridge printed nothing: ${run.stderr}`);
    return JSON.parse(line);
  };
  try {
    const board = "project-acme";
    assert.equal(bridge({ action: "ensure_board", board }).success, true);
    const created = bridge({
      action: "create",
      board,
      title: "Track",
      body: "kind: mail_track",
      assignee: "default",
      skills: ["ea-playbook"],
      workspace_kind: "dir",
      workspace_path: home,
    });
    assert.equal(created.success, true, JSON.stringify(created));
    assert.deepEqual(bridge({ action: "show", board, task_id: created.task_id }).task.skills, ["ea-playbook"]);
    const set = bridge({ action: "set_skills", board, task_id: created.task_id, skills: ["ea-mail-track"] });
    assert.equal(set.success, true, JSON.stringify(set));
    assert.deepEqual(bridge({ action: "show", board, task_id: created.task_id }).task.skills, ["ea-mail-track"]);
    assert.equal(bridge({ action: "set_skills", board, task_id: created.task_id, skills: [] }).success, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("OK: mail worker skills");
