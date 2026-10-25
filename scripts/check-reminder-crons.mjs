#!/usr/bin/env npx tsx
/**
 * Read-only check: Hermes cron jobs on a box that do not reach the owner.
 * Lists each undeliverable cron job and each reminder-like job that is not an
 * owner reminder (openspec change owner-reminder-delivery). Changes nothing.
 *
 * Usage:
 *   npx tsx scripts/check-reminder-crons.mjs --box joe [--box clara …]
 *   npx tsx scripts/check-reminder-crons.mjs --file path/to/jobs.json
 * Exit code: 0 = nothing found, 1 = findings, 2 = a box or file could not be read.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { cronJobUndeliverableReason, isUnmanagedReminderJob, normalizeDeliver } from "../src/cronDelivery.ts";

function usage(code) {
  console.error("usage: check-reminder-crons.mjs --box <slug> [--box <slug> …] | --file <jobs.json>");
  process.exit(code);
}

const sources = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const value = argv[i + 1];
  if ((flag === "--box" || flag === "--file") && value) {
    sources.push({ kind: flag.slice(2), value });
    i++;
  } else if (flag === "-h" || flag === "--help") {
    usage(0);
  } else {
    usage(2);
  }
}
if (!sources.length) usage(2);

/** jobs.json text of one box, read with `cat` in the stack container (read-only). */
function readBox(slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`invalid box slug "${slug}"`);
  return execFileSync(
    "ssh",
    [
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      `root@${slug}.box.joshu.me`,
      "docker exec deploy-joshu-stack-1 cat /root/.hermes/cron/jobs.json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
  );
}

function jobsOf(text) {
  const root = JSON.parse(text);
  return Array.isArray(root) ? root : Array.isArray(root?.jobs) ? root.jobs : [];
}

function oneLine(value, max = 70) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

let findings = 0;
let readErrors = 0;
for (const source of sources) {
  const label = source.kind === "box" ? source.value : source.value;
  let jobs;
  try {
    jobs = jobsOf(source.kind === "box" ? readBox(source.value) : readFileSync(source.value, "utf8"));
  } catch (error) {
    readErrors++;
    console.log(`${label}\tREAD-ERROR\t${oneLine(error instanceof Error ? error.message : error, 200)}`);
    continue;
  }
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const undeliverable = cronJobUndeliverableReason(job);
    const unmanaged = isUnmanagedReminderJob(job);
    if (!undeliverable && !unmanaged) continue;
    findings++;
    const origin = job.origin && typeof job.origin === "object" ? `${job.origin.platform}:${job.origin.chat_id}` : "-";
    const schedule = job.schedule?.display ?? job.schedule_display ?? job.schedule?.expr ?? "";
    console.log(
      [
        label,
        undeliverable ? "UNDELIVERABLE" : "UNMANAGED-REMINDER",
        job.id,
        `"${oneLine(job.name, 60)}"`,
        `deliver=${normalizeDeliver(job.deliver)}`,
        `origin=${origin}`,
        `schedule="${schedule}"`,
        `next=${job.next_run_at ?? "-"}`,
        `last=${job.last_status ?? "-"}`,
        undeliverable ? `reason="${undeliverable}"` : "reason=\"reminder-like job that is not an owner reminder\"",
      ].join("\t"),
    );
  }
}

console.error(`check-reminder-crons: ${findings} finding(s), ${readErrors} read error(s)`);
process.exit(readErrors ? 2 : findings ? 1 : 0);
