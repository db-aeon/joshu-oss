/**
 * Daily Hermes cron: reconcile onboarding prompts → ea-onboarding Kanban (no_agent).
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { callCronBridge, type CronBridgeJobSummary } from "../hermesCronBridge.js";

export const ONBOARDING_RECONCILE_CRON_JOB_NAME = "Joshu onboarding reconcile";
export const ONBOARDING_RECONCILE_SCRIPT_NAME = "onboarding-reconcile.sh";

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

function resolveOnboardingReconcileScriptSource(projectRoot: string): string | null {
  const fleet = path.join(projectRoot, "proprietary/scripts", ONBOARDING_RECONCILE_SCRIPT_NAME);
  if (existsSync(fleet)) return fleet;
  const oss = path.join(projectRoot, "scripts", ONBOARDING_RECONCILE_SCRIPT_NAME);
  if (existsSync(oss)) return oss;
  return null;
}

async function installOnboardingReconcileScript(projectRoot: string): Promise<string | null> {
  const source = resolveOnboardingReconcileScriptSource(projectRoot);
  if (!source) return null;
  const targetDir = path.join(hermesHome(), "scripts");
  const target = path.join(targetDir, ONBOARDING_RECONCILE_SCRIPT_NAME);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
  return ONBOARDING_RECONCILE_SCRIPT_NAME;
}

async function listJobs(): Promise<CronBridgeJobSummary[]> {
  const result = await callCronBridge({ action: "list", include_disabled: true });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron list failed");
  }
  return Array.isArray(result.jobs) ? result.jobs : [];
}

/** Idempotent install of daily onboarding reconcile cron (no_agent shell script). */
export async function syncOnboardingReconcileCron(
  projectRoot = process.cwd(),
): Promise<"created" | "updated" | "skipped"> {
  const script = await installOnboardingReconcileScript(projectRoot);
  if (!script) {
    console.warn("[onboarding-cron] onboarding-reconcile.sh not found — cron not installed");
    return "skipped";
  }

  // 06:00 UTC daily — reconcile runs before owner morning in most US timezones.
  const schedule = "0 6 * * *";
  const payload = {
    schedule,
    name: ONBOARDING_RECONCILE_CRON_JOB_NAME,
    script,
    no_agent: true,
    workdir: projectRoot,
  };

  const existing = await listJobs();
  const match = existing.find((j) => j.name === ONBOARDING_RECONCILE_CRON_JOB_NAME);
  if (match?.job_id) {
    const alreadyInstalled =
      match.schedule === schedule && match.script === script && match.enabled !== false;
    if (alreadyInstalled) return "skipped";
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
