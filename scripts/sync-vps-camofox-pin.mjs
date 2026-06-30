#!/usr/bin/env node
/**
 * Keep VPS deploy artifacts aligned with deploy/RELEASE.json camofoxBase.
 * Source of truth: deploy/RELEASE.json (update digest when bumping Camofox).
 *
 * Usage:
 *   node scripts/sync-vps-camofox-pin.mjs          # update deploy/Dockerfile ARG
 *   node scripts/sync-vps-camofox-pin.mjs --print  # print ref only (CI / shell)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = join(root, "deploy/Dockerfile");
const releaseJson = join(root, "deploy/RELEASE.json");

export function readCamofoxBaseFromReleaseJson() {
  const release = JSON.parse(readFileSync(releaseJson, "utf8"));
  const ref = release.camofoxBase?.trim();
  if (!ref) {
    throw new Error(`Missing camofoxBase in ${releaseJson}`);
  }
  if (ref.endsWith(":latest")) {
    throw new Error(
      `camofoxBase must be a digest pin (…@sha256:…), not :latest — got ${ref}`,
    );
  }
  return ref;
}

function syncDeployFiles(ref) {
  const docker = readFileSync(dockerfile, "utf8");
  const updatedDocker = docker.replace(/ARG CAMOFOX_BASE=[^\n]+/g, `ARG CAMOFOX_BASE=${ref}`);
  const dockerChanged = updatedDocker !== docker;
  if (dockerChanged) {
    writeFileSync(dockerfile, updatedDocker);
  }

  return { dockerChanged };
}

const printOnly = process.argv.includes("--print");

try {
  const ref = readCamofoxBaseFromReleaseJson();
  if (printOnly) {
    process.stdout.write(`${ref}\n`);
  } else {
    const { dockerChanged } = syncDeployFiles(ref);
    console.log(`[sync-vps-camofox-pin] ${ref}`);
    if (dockerChanged) {
      console.log(`[sync-vps-camofox-pin] updated ${dockerfile}`);
    } else {
      console.log(`[sync-vps-camofox-pin] deploy files already in sync`);
    }
  }
} catch (err) {
  console.error(`[sync-vps-camofox-pin] ${(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
}
