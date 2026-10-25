#!/usr/bin/env npx tsx
/**
 * Unit test: syncBoxCronJobs installs the onboarding reconcile, proactive tick, and proactive
 * hygiene Hermes cron jobs when the Joshu API starts, and does nothing when they exist.
 *
 * The test replaces the Python of Hermes with a fake cron bridge that keeps the jobs in a
 * JSON file, so it runs offline without Hermes.
 *
 * Usage: npm run test:box-cron-sync
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-box-cron-"));

// Fake Hermes venv: spawnHermesPython runs <venv>/bin/python3 <bridge script> with the payload on stdin.
const venvBin = path.join(tmp, "hermes-agent", "venv", "bin");
fs.mkdirSync(venvBin, { recursive: true });
const fakePython = path.join(venvBin, "python3");
fs.writeFileSync(
  fakePython,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.env.HERMES_HOME, "fake-cron-jobs.json");
const jobs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const { action, job_id, include_disabled, ...fields } = payload;
let result;
if (process.env.FAKE_CRON_BRIDGE_FAIL) {
  result = { success: false, error: "cron store unreadable" };
} else if (action === "list") {
  result = { success: true, jobs };
} else if (action === "create") {
  const job = { job_id: "job-" + (jobs.length + 1), enabled: true, ...fields };
  jobs.push(job);
  result = { success: true, job_id: job.job_id };
} else if (action === "update") {
  const job = jobs.find((j) => j.job_id === job_id);
  if (job) Object.assign(job, fields);
  result = job ? { success: true, job_id } : { success: false, error: "no such job" };
} else {
  result = { success: false, error: "unsupported action " + action };
}
fs.writeFileSync(file, JSON.stringify(jobs));
process.stdout.write(JSON.stringify(result));
`,
);
fs.chmodSync(fakePython, 0o755);

const arozData = path.join(tmp, "arozos-data");
const joshuDir = path.join(arozData, "files", "users", "owner", ".joshu");
fs.mkdirSync(path.join(arozData, "files", "users", "owner", "Desktop"), { recursive: true });
fs.mkdirSync(joshuDir, { recursive: true });

process.env.HERMES_BIN = path.join(venvBin, "hermes");
process.env.AROZ_DATA = arozData;
process.env.JOSHU_AROZ_USER = "owner";

// hermesVoiceRuntime reads HERMES_BIN at import time, so import after the env is set.
const { syncBoxCronJobs } = await import("../src/onboarding/boxCronSync.js");
const { ONBOARDING_RECONCILE_CRON_JOB_NAME } = await import("../src/onboarding/onboardingCronJobs.js");
const { PROACTIVE_CRON_JOB_NAME } = await import("../src/proactive/proactiveCronJobs.js");
const { PROACTIVE_HYGIENE_CRON_JOB_NAME } = await import("../src/proactive/hygieneCronJobs.js");

/** Each case gets its own Hermes home, so each case starts with its own job list. */
function useHermesHome(name, jobs = []) {
  const home = path.join(tmp, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "fake-cron-jobs.json"), JSON.stringify(jobs));
  process.env.HERMES_HOME = home;
  return home;
}

function jobNames(home) {
  const jobs = JSON.parse(fs.readFileSync(path.join(home, "fake-cron-jobs.json"), "utf8"));
  return jobs.map((job) => job.name).sort();
}

function writeSetup(finished) {
  const stateFile = path.join(joshuDir, "onboarding.json");
  const draftFile = path.join(joshuDir, "onboarding.draft.json");
  if (!finished) {
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(draftFile, { force: true });
    return;
  }
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ schemaVersion: 1, completed: true, completedAt: "2026-09-01T00:00:00Z", version: 1 }),
  );
  fs.writeFileSync(
    draftFile,
    JSON.stringify({
      ownerName: "Test Owner",
      assistantName: "Test Assistant",
      timezone: "America/New_York",
      workingHoursStart: "09:00",
    }),
  );
}

const allThree = [
  ONBOARDING_RECONCILE_CRON_JOB_NAME,
  PROACTIVE_CRON_JOB_NAME,
  PROACTIVE_HYGIENE_CRON_JOB_NAME,
].sort();

try {
  // Setup never finished: only the onboarding reconcile job, and a second start changes nothing.
  {
    writeSetup(false);
    const home = useHermesHome("never-finished");
    const first = await syncBoxCronJobs(projectRoot);
    assert.equal(first.setupFinished, false);
    assert.equal(first.onboardingReconcile, "created");
    assert.equal(first.proactiveTick, undefined);
    assert.equal(first.proactiveHygiene, undefined);
    assert.deepEqual(jobNames(home), [ONBOARDING_RECONCILE_CRON_JOB_NAME]);
    assert.ok(fs.existsSync(path.join(home, "scripts", "onboarding-reconcile.sh")));

    const second = await syncBoxCronJobs(projectRoot);
    assert.equal(second.onboardingReconcile, "skipped");
    assert.deepEqual(jobNames(home), [ONBOARDING_RECONCILE_CRON_JOB_NAME]);
  }

  // Setup finished on an older release, no jobs (box barrett): the start installs all three.
  {
    writeSetup(true);
    const home = useHermesHome("finished-no-jobs");
    const first = await syncBoxCronJobs(projectRoot);
    assert.equal(first.setupFinished, true);
    assert.equal(first.onboardingReconcile, "created");
    assert.equal(first.proactiveTick, "created");
    assert.equal(first.proactiveHygiene, "created");
    assert.deepEqual(jobNames(home), allThree);

    const second = await syncBoxCronJobs(projectRoot);
    assert.equal(second.onboardingReconcile, "skipped");
    assert.equal(second.proactiveTick, "skipped");
    assert.equal(second.proactiveHygiene, "skipped");
    assert.deepEqual(jobNames(home), allThree);
  }

  // Setup finished, only the proactive tick (box cleo): the start adds the two missing jobs.
  {
    writeSetup(true);
    const home = useHermesHome("finished-tick-only", [
      {
        job_id: "job-tick",
        name: PROACTIVE_CRON_JOB_NAME,
        schedule: "0 * * * *",
        script: "proactive-tick.sh",
        no_agent: true,
        enabled: true,
      },
    ]);
    const result = await syncBoxCronJobs(projectRoot);
    assert.equal(result.onboardingReconcile, "created");
    assert.equal(result.proactiveTick, "skipped");
    assert.equal(result.proactiveHygiene, "created");
    assert.deepEqual(jobNames(home), allThree);
  }

  // A cron bridge error on one job does not stop the other jobs.
  {
    writeSetup(true);
    useHermesHome("bridge-error");
    process.env.FAKE_CRON_BRIDGE_FAIL = "1";
    const result = await syncBoxCronJobs(projectRoot);
    delete process.env.FAKE_CRON_BRIDGE_FAIL;
    assert.match(String(result.onboardingReconcile), /^error: /);
    assert.match(String(result.proactiveTick), /^error: /);
    assert.match(String(result.proactiveHygiene), /^error: /);
  }

  console.log("box cron sync tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
