#!/usr/bin/env node
/**
 * Keep VPS deploy artifacts aligned with deploy/RELEASE.json hermesRef.
 * Source of truth: deploy/RELEASE.json (updated by npm run hermes:update).
 *
 * Usage:
 *   node scripts/sync-vps-hermes-pin.mjs          # update deploy/Dockerfile ARG
 *   node scripts/sync-vps-hermes-pin.mjs --print  # print ref only (CI / shell)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = join(root, "deploy/Dockerfile");
const releaseJson = join(root, "deploy/RELEASE.json");

export function readHermesAgentRefFromReleaseJson() {
  const release = JSON.parse(readFileSync(releaseJson, "utf8"));
  const ref = release.hermesRef?.trim();
  if (!ref) {
    throw new Error(`Missing hermesRef in ${releaseJson}`);
  }
  return ref;
}

function syncDeployFiles(ref) {
  const docker = readFileSync(dockerfile, "utf8");
  const updatedDocker = docker.replace(/ARG HERMES_AGENT_REF=[^\n]+/g, `ARG HERMES_AGENT_REF=${ref}`);
  const dockerChanged = updatedDocker !== docker;
  if (dockerChanged) {
    writeFileSync(dockerfile, updatedDocker);
  }

  return { dockerChanged };
}

const printOnly = process.argv.includes("--print");

try {
  const ref = readHermesAgentRefFromReleaseJson();
  if (printOnly) {
    process.stdout.write(`${ref}\n`);
  } else {
    const { dockerChanged } = syncDeployFiles(ref);
    console.log(`[sync-vps-hermes-pin] ${ref}`);
    if (dockerChanged) {
      console.log(`[sync-vps-hermes-pin] updated ${dockerfile}`);
    } else {
      console.log(`[sync-vps-hermes-pin] deploy files already in sync`);
    }
  }
} catch (err) {
  console.error(`[sync-vps-hermes-pin] ${(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
}
