#!/usr/bin/env node
/**
 * Keep VPS deploy artifacts aligned with modal_app.py HERMES_AGENT_REF default.
 * Source of truth: modal_app.py (updated by npm run hermes:update).
 *
 * Usage:
 *   node scripts/sync-vps-hermes-pin.mjs          # update deploy/Dockerfile + deploy/RELEASE.json
 *   node scripts/sync-vps-hermes-pin.mjs --print  # print ref only (CI / shell)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modalApp = join(root, "modal_app.py");
const dockerfile = join(root, "deploy/Dockerfile");
const releaseJson = join(root, "deploy/RELEASE.json");

export function readHermesAgentRefFromModalApp() {
  const text = readFileSync(modalApp, "utf8");
  const match = text.match(
    /HERMES_AGENT_REF\s*=\s*os\.environ\.get\("HERMES_AGENT_REF",\s*"([^"]+)"\)/,
  );
  if (!match) {
    throw new Error(`Could not parse HERMES_AGENT_REF default from ${modalApp}`);
  }
  return match[1];
}

function syncDeployFiles(ref) {
  const docker = readFileSync(dockerfile, "utf8");
  const updatedDocker = docker.replace(/ARG HERMES_AGENT_REF=[^\n]+/g, `ARG HERMES_AGENT_REF=${ref}`);
  const dockerChanged = updatedDocker !== docker;
  if (dockerChanged) {
    writeFileSync(dockerfile, updatedDocker);
  }

  const release = JSON.parse(readFileSync(releaseJson, "utf8"));
  const releaseChanged = release.hermesRef !== ref;
  if (releaseChanged) {
    release.hermesRef = ref;
    release.builtAt = new Date().toISOString();
    writeFileSync(releaseJson, `${JSON.stringify(release, null, 2)}\n`);
  }

  return { dockerChanged, releaseChanged };
}

const printOnly = process.argv.includes("--print");

try {
  const ref = readHermesAgentRefFromModalApp();
  if (printOnly) {
    process.stdout.write(`${ref}\n`);
  } else {
    const { dockerChanged, releaseChanged } = syncDeployFiles(ref);
    console.log(`[sync-vps-hermes-pin] ${ref}`);
    if (dockerChanged || releaseChanged) {
      const parts = [];
      if (dockerChanged) parts.push(dockerfile);
      if (releaseChanged) parts.push(releaseJson);
      console.log(`[sync-vps-hermes-pin] updated ${parts.join(" and ")}`);
    } else {
      console.log(`[sync-vps-hermes-pin] deploy files already in sync`);
    }
  }
} catch (err) {
  console.error(`[sync-vps-hermes-pin] ${(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
}
