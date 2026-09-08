/**
 * Hourly Hermes cron: proactive Kanban nudge tick (no_agent — zero LLM tokens).
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { callCronBridge, type CronBridgeJobSummary } from "../hermesCronBridge.js";

export const PROACTIVE_CRON_JOB_NAME = "Joshu proactive tick";
export const PROACTIVE_CRON_SCRIPT_NAME = "proactive-tick.sh";

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

function resolveProactiveTickScriptSource(projectRoot: string): string | null {
  const fleet = path.join(projectRoot, "proprietary/scripts", PROACTIVE_CRON_SCRIPT_NAME);
  if (existsSync(fleet)) return fleet;
  const oss = path.join(projectRoot, "scripts", PROACTIVE_CRON_SCRIPT_NAME);
  if (existsSync(oss)) return oss;
  return null;
}

/** Hermes no_agent crons require script paths relative to ~/.hermes/scripts/. */
async function installProactiveTickScript(projectRoot: string): Promise<string | null> {
  const source = resolveProactiveTickScriptSource(projectRoot);
  if (!source) return null;
  const targetDir = path.join(hermesHome(), "scripts");
  const target = path.join(targetDir, PROACTIVE_CRON_SCRIPT_NAME);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
  return PROACTIVE_CRON_SCRIPT_NAME;
}

async function listJobs(): Promise<CronBridgeJobSummary[]> {
  const result = await callCronBridge({ action: "list", include_disabled: true });
  if (!result.success) {
    throw new Error(typeof result.error === "string" ? result.error : "cron list failed");
  }
  return Array.isArray(result.jobs) ? result.jobs : [];
}

/** Idempotent install of hourly proactive tick cron (no_agent shell script). */
export async function syncProactiveCron(projectRoot = process.cwd()): Promise<"created" | "updated" | "skipped"> {
  const script = await installProactiveTickScript(projectRoot);
  if (!script) {
    console.warn("[proactive-cron] proactive-tick.sh not found — cron not installed");
    return "skipped";
  }

  const schedule = "0 * * * *";
  const payload = {
    schedule,
    name: PROACTIVE_CRON_JOB_NAME,
    script,
    no_agent: true,
    workdir: projectRoot,
  };

  const existing = await listJobs();
  const match = existing.find((j) => j.name === PROACTIVE_CRON_JOB_NAME);
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
