/**
 * Hourly Hermes cron job: commit+push learning state to private GitHub.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { callCronBridge, type CronBridgeJobSummary } from "./hermesCronBridge.js";

export const LEARNING_GIT_CRON_JOB_NAME = "Hermes learning GitHub sync";
export const LEARNING_GIT_CRON_SCRIPT_NAME = "hermes-learning-github-sync.sh";

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

/** Hermes no_agent crons require script paths relative to ~/.hermes/scripts/. */
async function installLearningGitCronScript(): Promise<string> {
  const source = path.join(process.cwd(), "scripts", LEARNING_GIT_CRON_SCRIPT_NAME);
  const targetDir = path.join(hermesHome(), "scripts");
  const target = path.join(targetDir, LEARNING_GIT_CRON_SCRIPT_NAME);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
  return LEARNING_GIT_CRON_SCRIPT_NAME;
}

async function listJobs(): Promise<CronBridgeJobSummary[]> {
  const result = await callCronBridge({ action: "list", include_disabled: true });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron list failed");
  }
  return Array.isArray(result.jobs) ? result.jobs : [];
}

/** Idempotent install of hourly GitHub sync cron (no_agent shell script). */
export async function syncHermesLearningGitCron(): Promise<"created" | "updated" | "skipped"> {
  if (!process.env.JOSHU_HERMES_LEARNING_GITHUB_REPO?.trim() && !process.env.JOSHU_HERMES_LEARNING_GITHUB_REMOTE?.trim()) {
    return "skipped";
  }

  const script = await installLearningGitCronScript();
  const schedule = "0 * * * *";
  const payload = {
    schedule,
    name: LEARNING_GIT_CRON_JOB_NAME,
    script,
    no_agent: true,
    workdir: process.cwd(),
  };

  const existing = await listJobs();
  const match = existing.find((j) => j.name === LEARNING_GIT_CRON_JOB_NAME);
  if (match?.job_id) {
    const alreadyInstalled =
      match.schedule === schedule &&
      match.script === script &&
      match.enabled !== false;
    if (alreadyInstalled) {
      return "skipped";
    }
    const result = await callCronBridge({ action: "update", job_id: match.job_id, ...payload });
    if (!result.success) {
      throw new Error(typeof result.error === "string" ? result.error : "cron update failed");
    }
    return "updated";
  }

  const result = await callCronBridge({ action: "create", ...payload });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron create failed");
  }
  return "created";
}
