#!/usr/bin/env npx tsx
/**
 * Remove legacy EA scheduling one-shot Hermes crons (thread-level and pre-Kanban case crons).
 *
 * Usage: npx tsx scripts/migrate-remove-scheduling-crons.mjs
 */
import { callCronBridge } from "../src/hermesCronBridge.js";

const LEGACY_PREFIXES = ["EA scheduling case ", "EA scheduling nylas/", "EA scheduling gmail/"];

async function main() {
  const list = await callCronBridge({ action: "list", include_disabled: true });
  if (!list.success || !Array.isArray(list.jobs)) {
    throw new Error(list.error ?? "cron list failed");
  }

  let removed = 0;
  for (const job of list.jobs) {
    const name = job.name ?? "";
    if (!LEGACY_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (!job.job_id) continue;
    const result = await callCronBridge({ action: "remove", job_id: job.job_id });
    if (result.success) {
      console.info(`[migrate] removed cron ${name} (${job.job_id})`);
      removed += 1;
    } else {
      console.warn(`[migrate] failed to remove ${name}: ${result.error ?? "unknown"}`);
    }
  }
  console.info(`[migrate] done — removed ${removed} legacy scheduling cron(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
