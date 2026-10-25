#!/usr/bin/env npx tsx
/**
 * Unit tests: the Joshu state folder survives a recreate of the stack container
 * (change joshu-state-volume). Covers the path helpers, the boot migration, and the
 * carry-over script of the instance agent.
 *
 * Usage: npm run test:joshu-state-dir
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { carryOverJoshuState } from "../packages/instance-agent/src/stateCarryOver.js";
import { browserHandoffDir } from "../src/browserHandoff/paths.js";
import { JOSHU_STATE_ENTRIES, joshuStateDir, migrateLegacyJoshuState } from "../src/joshuStateDir.js";
import { proactiveStatePath } from "../src/proactive/paths.js";
import { MembershipStore, teamsDir } from "../src/teams/membership.js";
import { TeamRoomStore } from "../src/teams/roomStore.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const carryScript = fs.readFileSync(path.join(repoRoot, "deploy", "scripts", "carry-over-joshu-state.sh"), "utf8");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

/** A 0.1.56 box: the team state in `<projectRoot>/.joshu` (the writable layer). */
function seedLegacyState(projectRoot) {
  const legacy = path.join(projectRoot, ".joshu");
  writeJson(path.join(legacy, "teams", "memberships.json"), {
    version: 1,
    teams: [{ slug: "acme", remoteSlug: "acme", bossUrl: null, memberId: "m_boss", token: "tok", isBoss: true, joinedAt: "2026-10-16T00:00:00Z", schedule: "45 8 * * 1-5", cronJobId: "job1" }],
  });
  writeJson(path.join(legacy, "teams", "hosted", "acme", "room.json"), { slug: "acme", cards: [1, 2, 3, 4, 5] });
  fs.writeFileSync(path.join(legacy, "teams", "hosted", "acme", "log.jsonl"), '{"id":"a"}\n{"id":"b"}\n');
  writeJson(path.join(legacy, "proactive", "state.json"), { lastNudge: { taskId: "t_abc123" } });
  fs.writeFileSync(path.join(legacy, "connectors-providers.env"), "FAL_KEY=x\n");
  writeJson(path.join(legacy, "last30days", "runs", "r.json"), {});
  return legacy;
}

const tmpRoots = [];
async function tmp(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

const savedStateDir = process.env.JOSHU_STATE_DIR;
const savedTeamsDir = process.env.JOSHU_TEAMS_DIR;
delete process.env.JOSHU_TEAMS_DIR;

try {
  // The carry-over script copies the same entries to the folder that the image sets.
  assert.ok(carryScript.includes(`for name in ${JOSHU_STATE_ENTRIES.join(" ")}; do`), "same entries as JOSHU_STATE_ENTRIES");
  assert.ok(carryScript.includes('"${JOSHU_CARRY_SRC:-/opt/joshu/.joshu}"'));
  assert.ok(carryScript.includes('"${JOSHU_CARRY_DST:-/var/lib/arozos/joshu-state}"'));
  const dockerfile = fs.readFileSync(path.join(repoRoot, "deploy", "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("JOSHU_STATE_DIR=/var/lib/arozos/joshu-state "), "deploy/Dockerfile sets JOSHU_STATE_DIR");
  assert.ok(dockerfile.includes("deploy/scripts/carry-over-joshu-state.sh"), "host bundle has the carry-over script");
  const compose = fs.readFileSync(path.join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
  assert.ok(compose.includes("- joshu_arozos:/var/lib/arozos"), "the state folder is in volume joshu_arozos");
  const remoteUpgrade = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "upgrade-box-remote.sh"), "utf8");
  assert.ok(
    remoteUpgrade.indexOf("carry-over-joshu-state.sh") < remoteUpgrade.indexOf("up -d --force-recreate caddy joshu-stack"),
    "the SSH upgrade carries the state over before the recreate",
  );
  const agentIndex = fs.readFileSync(path.join(repoRoot, "packages", "instance-agent", "src", "index.ts"), "utf8");
  for (const recreate of ['runCompose(["up", "-d", "--force-recreate", ...UPDATE_RECREATE_SERVICES])', 'runCompose(["up", "-d", "--force-recreate", "joshu-stack"])']) {
    const at = agentIndex.indexOf(recreate);
    assert.ok(at > 0 && agentIndex.slice(at - 200, at).includes("await carryOverStackState("), `carry-over before ${recreate}`);
  }

  // Without JOSHU_STATE_DIR (local development): `<projectRoot>/.joshu`, as before.
  delete process.env.JOSHU_STATE_DIR;
  const devRoot = await tmp("joshu-state-dev-");
  assert.equal(joshuStateDir(devRoot), path.join(devRoot, ".joshu"));
  assert.equal(teamsDir(devRoot), path.join(devRoot, ".joshu", "teams"));
  assert.deepEqual(migrateLegacyJoshuState(devRoot), [], "same folder: nothing to copy");

  // With JOSHU_STATE_DIR (the sandbox image): every state path is in the volume.
  const projectRoot = await tmp("joshu-state-root-");
  const volume = path.join(await tmp("joshu-state-vol-"), "joshu-state");
  process.env.JOSHU_STATE_DIR = volume;
  assert.equal(joshuStateDir(projectRoot), volume);
  assert.equal(teamsDir(projectRoot), path.join(volume, "teams"));
  assert.equal(proactiveStatePath(projectRoot), path.join(volume, "proactive", "state.json"));
  assert.equal(browserHandoffDir(projectRoot), path.join(volume, "browser-handoff"));
  process.env.JOSHU_TEAMS_DIR = path.join(projectRoot, "custom-teams");
  assert.equal(teamsDir(projectRoot), path.join(projectRoot, "custom-teams"), "JOSHU_TEAMS_DIR still wins");
  delete process.env.JOSHU_TEAMS_DIR;

  // Boot migration: a restart (no recreate) of an old box copies the legacy state.
  const legacy = seedLegacyState(projectRoot);
  fs.mkdirSync(path.join(volume, "proactive"), { recursive: true }); // an empty folder counts as missing
  const copied = migrateLegacyJoshuState(projectRoot);
  assert.deepEqual(copied.sort(), ["connectors-providers.env", "proactive", "teams"]);
  const members = await new MembershipStore(teamsDir(projectRoot)).find("acme");
  assert.equal(members?.token, "tok");
  assert.equal(members?.cronJobId, "job1");
  assert.equal(
    fs.readFileSync(path.join(volume, "teams", "hosted", "acme", "log.jsonl"), "utf8"),
    '{"id":"a"}\n{"id":"b"}\n',
  );
  assert.ok(new TeamRoomStore(teamsDir(projectRoot)), "team room store opens on the volume");
  assert.equal(JSON.parse(fs.readFileSync(proactiveStatePath(projectRoot), "utf8")).lastNudge.taskId, "t_abc123");
  assert.ok(!fs.existsSync(path.join(volume, "last30days")), "last30days has its own migration");
  assert.ok(fs.existsSync(path.join(legacy, "teams", "memberships.json")), "the legacy copy stays");
  assert.deepEqual(fs.readdirSync(volume).filter((n) => n.includes(".migrate-")), [], "no temp folders left");

  // State in the volume always wins: a second boot copies nothing and overwrites nothing.
  writeJson(path.join(volume, "teams", "memberships.json"), { version: 1, teams: [] });
  assert.deepEqual(migrateLegacyJoshuState(projectRoot), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(volume, "teams", "memberships.json"), "utf8")).teams, []);

  // Carry-over script of the instance agent (runs in the old container before the recreate).
  const oldLayer = path.join(await tmp("joshu-carry-src-"), ".joshu");
  const oldRoot = path.dirname(oldLayer);
  seedLegacyState(oldRoot);
  const target = path.join(await tmp("joshu-carry-dst-"), "joshu-state");
  fs.mkdirSync(path.join(target, "sms"), { recursive: true });
  fs.mkdirSync(path.join(oldLayer, "sms"), { recursive: true });
  fs.writeFileSync(path.join(oldLayer, "sms", "sessions.json"), "{}\n");
  writeJson(path.join(target, "connectors-providers.env"), "kept");
  const installDir = repoRoot;
  const runScript = async (script) =>
    (await execFileAsync("sh", ["-c", script], { env: { ...process.env, JOSHU_CARRY_SRC: oldLayer, JOSHU_CARRY_DST: target } })).stdout;

  const first = await carryOverJoshuState(installDir, runScript);
  assert.equal(first.ok, true, first.lines.join("; "));
  assert.deepEqual(first.lines.sort(), ["copied proactive", "copied sms", "copied teams", "kept connectors-providers.env"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "teams", "memberships.json"), "utf8")).teams[0].token, "tok");
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "teams", "hosted", "acme", "room.json"), "utf8")).cards.length, 5);
  assert.equal(fs.readFileSync(path.join(target, "sms", "sessions.json"), "utf8"), "{}\n", "empty folder filled");
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "connectors-providers.env"), "utf8")), "kept");
  assert.equal((fs.statSync(target).mode & 0o777).toString(8), "700");
  assert.deepEqual(fs.readdirSync(target).filter((n) => n.startsWith(".")), [], "no temp entries left");

  // Second recreate (or a box already on the new release): nothing changes.
  const second = await carryOverJoshuState(installDir, runScript);
  assert.deepEqual(second.lines.sort(), ["kept connectors-providers.env", "kept proactive", "kept sms", "kept teams"]);

  // A box with no legacy folder (new box, or the old layer is already gone).
  const none = await carryOverJoshuState(installDir, async (script) =>
    (await execFileAsync("sh", ["-c", script], { env: { ...process.env, JOSHU_CARRY_SRC: path.join(oldRoot, "missing"), JOSHU_CARRY_DST: target } })).stdout,
  );
  assert.equal(none.ok, true);

  // The stack container is down: the update goes on.
  const down = await carryOverJoshuState(installDir, async () => {
    throw new Error("service joshu-stack is not running");
  });
  assert.equal(down.ok, false);
  assert.match(down.error ?? "", /not running/);

  // A host without the script (bundle not installed): the update goes on.
  const missing = await carryOverJoshuState(path.join(oldRoot, "no-install"), runScript);
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /no carry-over script/);

  console.log("test-joshu-state-dir: ok");
} finally {
  if (savedStateDir === undefined) delete process.env.JOSHU_STATE_DIR;
  else process.env.JOSHU_STATE_DIR = savedStateDir;
  if (savedTeamsDir !== undefined) process.env.JOSHU_TEAMS_DIR = savedTeamsDir;
  for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true });
}
