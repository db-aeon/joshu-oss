/**
 * Boot cleanup for boxes that had the last30days app (change research-reports, design decision
 * D11). Research reports replace the app. Deleting the app from the image does not delete its
 * copies on a box, so Joshu removes them at boot. The cleanup runs again safely and never touches
 * the old results in `research/last30days` or the engine state in `.joshu/last30days`.
 * The Hermes plugin entries are dropped by `syncResearchPlugin` in `src/hermesApi.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAppSkillsRegistryPath } from "../appSkillsRegistry.js";
import { callCronBridge, type CronBridgePayload, type CronBridgeResult } from "../hermesCronBridge.js";

export const LAST30DAYS_WATCH_CRON_NAMES = ["last30days: watchlist daily", "last30days: watchlist weekly"] as const;
const LAST30DAYS_SKILLS = ["last30days-chat", "last30days-gui"] as const;
const LAST30DAYS_CRON_SCRIPTS = ["last30days-watchlist-run.sh", "last30days-watchlist-weekly.sh"] as const;

export type RetirePaths = {
  hermesHome: string;
  arozData: string;
  /** `.joshu/app-skills.json` of the owner. */
  appSkillsRegistryPath: string;
};

export function defaultRetirePaths(projectRoot: string): RetirePaths {
  const arozData = process.env.AROZ_DATA?.trim() || path.join(projectRoot, ".local", "arozos-data");
  return {
    hermesHome: process.env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes"),
    arozData,
    appSkillsRegistryPath: resolveAppSkillsRegistryPath(projectRoot, arozData),
  };
}

function removePath(target: string, removed: string[]): void {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(target);
}

/** Remove the files of the last30days app. Returns the removed paths. */
export function retireLast30daysFiles(paths: RetirePaths): string[] {
  const removed: string[] = [];
  for (const script of LAST30DAYS_CRON_SCRIPTS) removePath(path.join(paths.hermesHome, "scripts", script), removed);
  removePath(path.join(paths.hermesHome, "skills", "apps", "last30days"), removed);
  removePath(path.join(paths.hermesHome, "plugins", "joshu-last30days"), removed);
  for (const skill of LAST30DAYS_SKILLS) removePath(path.join(paths.hermesHome, "skills", "joshu", skill), removed);
  removePath(path.join(paths.arozData, "subservice", "last30days"), removed);
  removePath(path.join(paths.arozData, "system", "desktop", "template", "last30days.shortcut"), removed);
  const usersRoot = path.join(paths.arozData, "files", "users");
  if (fs.existsSync(usersRoot)) {
    for (const user of fs.readdirSync(usersRoot)) {
      removePath(path.join(usersRoot, user, "Desktop", "last30days.shortcut"), removed);
    }
  }

  try {
    const doc = JSON.parse(fs.readFileSync(paths.appSkillsRegistryPath, "utf8")) as { skills?: unknown };
    const skills = Array.isArray(doc.skills) ? doc.skills.filter((s): s is string => typeof s === "string") : [];
    const kept = skills.filter((s) => !(LAST30DAYS_SKILLS as readonly string[]).includes(s));
    if (kept.length !== skills.length) {
      fs.writeFileSync(paths.appSkillsRegistryPath, `${JSON.stringify({ ...doc, skills: kept }, null, 2)}\n`, "utf8");
      removed.push(`${paths.appSkillsRegistryPath} (last30days skills)`);
    }
  } catch {
    /* no registry */
  }
  return removed;
}

/** Remove the two last30days watch Hermes cron jobs by name. Returns the removed job names. */
export async function retireLast30daysCronJobs(
  bridge: (payload: CronBridgePayload) => Promise<CronBridgeResult> = callCronBridge,
): Promise<string[]> {
  const listed = await bridge({ action: "list", include_disabled: true });
  if (!listed.success) throw new Error(typeof listed.error === "string" ? listed.error : "cron list failed");
  const jobs = Array.isArray(listed.jobs) ? listed.jobs : [];
  const removed: string[] = [];
  for (const job of jobs) {
    if (!job.job_id || !(LAST30DAYS_WATCH_CRON_NAMES as readonly string[]).includes(job.name ?? "")) continue;
    await bridge({ action: "remove", job_id: job.job_id });
    removed.push(job.name!);
  }
  return removed;
}

/** Remove every last30days leftover on this box. Never throws. */
export async function retireLast30days(projectRoot: string): Promise<void> {
  try {
    const files = retireLast30daysFiles(defaultRetirePaths(projectRoot));
    if (files.length) console.info(`[research] removed last30days app files: ${files.join(", ")}`);
  } catch (err) {
    console.warn(`[research] last30days file cleanup failed: ${(err as Error).message}`);
  }
  try {
    const jobs = await retireLast30daysCronJobs();
    if (jobs.length) console.info(`[research] removed last30days cron jobs: ${jobs.join(", ")}`);
  } catch (err) {
    console.warn(`[research] last30days cron cleanup failed: ${(err as Error).message}`);
  }
}
