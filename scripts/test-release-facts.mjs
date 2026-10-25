#!/usr/bin/env npx tsx
/**
 * Unit tests: release facts (factory/release-facts.yaml) and the one-time Hermes job that checks
 * Hermes memory and the box-made skills after an upgrade.
 * Spec: openspec/changes/release-facts-memory-check/specs/release-facts/spec.md
 *
 * Usage: npm run test:release-facts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildReleaseFactsPrompt,
  loadReleaseFacts,
  parseReleaseFacts,
  releaseFactsJobName,
  scheduleReleaseFactsCheck,
  selectFactsToCheck,
} from "../src/releaseFacts.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// --- The factory file is valid ---
{
  const facts = loadReleaseFacts(root);
  assert.ok(facts.length > 0, "factory/release-facts.yaml has facts");
  const raw = fs.readFileSync(path.join(root, "factory/release-facts.yaml"), "utf8");
  assert.equal(parseReleaseFacts(raw).length, (raw.match(/^  - id:/gm) ?? []).length, "every fact has all fields");
  assert.equal(new Set(facts.map((f) => f.id)).size, facts.length, "fact ids are unique");
  for (const f of facts) {
    assert.match(f.introducedIn, /^\d+\.\d+\.\d+$/, `${f.id}: introducedIn is a release version`);
    assert.doesNotMatch(`${f.fact} ${f.wasBelieved}`, /[\w.+-]+@[\w-]+\.[\w.]+/, `${f.id}: no email address`);
    assert.doesNotMatch(`${f.fact} ${f.wasBelieved}`, /\+?\d[\d ()-]{8,}\d/, `${f.id}: no phone number`);
  }
}

const FACTS = [
  { id: "a", introducedIn: "0.1.53", fact: "A is true.", wasBelieved: "A is false." },
  { id: "b", introducedIn: "0.1.55", fact: "B is true.", wasBelieved: "B is false." },
  { id: "c", introducedIn: "0.1.60", fact: "C is true.", wasBelieved: "C is false." },
];
const ids = (facts) => facts.map((f) => f.id);

// --- Which facts a box checks ---
assert.deepEqual(ids(selectFactsToCheck(FACTS, "0.1.54", "0.1.55")), ["b"], "only facts after the last check");
assert.deepEqual(ids(selectFactsToCheck(FACTS, "0.1.52", "0.1.56")), ["a", "b"], "a skipped release is covered");
assert.deepEqual(ids(selectFactsToCheck(FACTS, null, "0.1.55")), ["a", "b"], "first check: every fact up to the release");
assert.deepEqual(ids(selectFactsToCheck(FACTS, "0.1.55", "0.1.55")), [], "same release: nothing");
assert.deepEqual(ids(selectFactsToCheck(FACTS, null, "0.0.0-dev")), [], "dev build: nothing");

// --- The prompt of the one-time job ---
{
  const prompt = buildReleaseFactsPrompt(FACTS.slice(0, 2), "0.1.55", "/root/.hermes");
  assert.match(prompt, /release 0\.1\.55/);
  assert.match(prompt, /A is true\./);
  assert.match(prompt, /Old belief that is now untrue: B is false\./);
  assert.match(prompt, /\/root\/\.hermes\/memories\/MEMORY\.md/);
  assert.match(prompt, /\/root\/\.hermes\/memories\/USER\.md/);
  assert.match(prompt, /skip \/root\/\.hermes\/skills\/joshu/, "factory skills are left to the skills seed");
  assert.match(prompt, /"§"/, "the job keeps the memory entry separators");
}

// --- Scheduling: once per release, stamp after the job exists ---
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "release-facts-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-facts-root-"));
  fs.mkdirSync(path.join(projectRoot, "factory"));
  fs.writeFileSync(
    path.join(projectRoot, "factory/release-facts.yaml"),
    `facts:\n${FACTS.map((f) => `  - id: ${f.id}\n    introducedIn: "${f.introducedIn}"\n    fact: ${f.fact}\n    wasBelieved: ${f.wasBelieved}\n`).join("")}`,
  );
  const stamp = path.join(home, ".joshu-release-facts-checked");
  const calls = [];
  let jobs = [];
  const cron = async (payload) => {
    calls.push(payload);
    if (payload.action === "list") return { success: true, jobs };
    if (payload.action === "create") {
      jobs.push({ name: payload.name, job_id: "j1" });
      return { success: true, job_id: "j1" };
    }
    throw new Error(`unexpected ${payload.action}`);
  };

  fs.writeFileSync(stamp, "0.1.54\n");
  const first = await scheduleReleaseFactsCheck(projectRoot, { cron, version: "0.1.55", home });
  assert.equal(first.action, "scheduled");
  assert.deepEqual(first.factIds, ["b"]);
  const create = calls.find((c) => c.action === "create");
  assert.equal(create.name, releaseFactsJobName("0.1.55"));
  assert.equal(create.schedule, "15m", "one-time schedule");
  assert.equal(create.repeat, 1);
  assert.equal(create.deliver, "local", "the job sends nothing to the owner");
  assert.deepEqual(create.enabled_toolsets, ["file", "skills"]);
  assert.equal(fs.readFileSync(stamp, "utf8").trim(), "0.1.55");

  calls.length = 0;
  const again = await scheduleReleaseFactsCheck(projectRoot, { cron, version: "0.1.55", home });
  assert.equal(again.action, "none", "a restart at the same release adds no job");
  assert.equal(calls.length, 0);

  // The job exists but the stamp is old (a crash after create): no second job.
  fs.writeFileSync(stamp, "0.1.54\n");
  const exists = await scheduleReleaseFactsCheck(projectRoot, { cron, version: "0.1.55", home });
  assert.equal(exists.action, "already_scheduled");
  assert.equal(jobs.length, 1);

  // A release without new facts moves the stamp and adds no job.
  const quiet = await scheduleReleaseFactsCheck(projectRoot, { cron, version: "0.1.56", home });
  assert.equal(quiet.action, "none");
  assert.equal(fs.readFileSync(stamp, "utf8").trim(), "0.1.56");
  assert.equal(jobs.length, 1);

  // A failed create keeps the stamp, so the next start tries again.
  const failing = async (payload) => (payload.action === "list" ? { success: true, jobs: [] } : { success: false, error: "boom" });
  await assert.rejects(scheduleReleaseFactsCheck(projectRoot, { cron: failing, version: "0.1.60", home }), /boom/);
  assert.equal(fs.readFileSync(stamp, "utf8").trim(), "0.1.56");

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log("test-release-facts: ok");
