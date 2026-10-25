#!/usr/bin/env node
/**
 * Set the fleet release version in the pin files: deploy/RELEASE.json and
 * deploy/.env.vps.example. The image refs get the new tag. Hermes and gbrain
 * pins and the field "notes" do not change (the release notes step writes "notes").
 *
 * Usage:
 *   node scripts/bump-release-pins.mjs <version>          # for example 0.1.52
 *   node scripts/bump-release-pins.mjs <version> --check  # validate only, change nothing
 *
 * The version must be MAJOR.MINOR.PATCH and higher than the current version.
 * Prints the previous version on stdout (the release workflow uses it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseJson = join(root, "deploy/RELEASE.json");
const envExample = join(root, "deploy/.env.vps.example");

const [version, flag] = process.argv.slice(2);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.error(`[bump-release-pins] ${message}`);
  process.exit(2);
}

function compare(a, b) {
  const pa = a.match(SEMVER).slice(1).map(Number);
  const pb = b.match(SEMVER).slice(1).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

if (!version || !SEMVER.test(version)) fail(`version must look like 0.1.52, got '${version ?? ""}'`);

const release = JSON.parse(readFileSync(releaseJson, "utf8"));
const previous = release.version;
if (!SEMVER.test(previous ?? "")) fail(`deploy/RELEASE.json has no valid version: '${previous}'`);
if (compare(version, previous) <= 0) fail(`version ${version} is not higher than ${previous}`);

// Replace only the tag of an image ref (the part after the last ':').
const retag = (ref) => ref.replace(/:[^:/]+$/, `:${version}`);

if (flag === "--check") {
  console.log(previous);
  process.exit(0);
}

for (const key of ["imageRef", "voiceImageRef", "instanceAgentImageRef"]) {
  if (typeof release[key] !== "string") fail(`deploy/RELEASE.json has no ${key}`);
  release[key] = retag(release[key]);
}
release.version = version;
release.builtAt = new Date().toISOString();
writeFileSync(releaseJson, `${JSON.stringify(release, null, 2)}\n`);

const env = readFileSync(envExample, "utf8");
const updatedEnv = env
  .replace(/^JOSHU_RELEASE_VERSION=.*$/m, `JOSHU_RELEASE_VERSION=${version}`)
  .replace(/^(JOSHU_IMAGE_REF|JOSHU_VOICE_IMAGE_REF|JOSHU_INSTANCE_AGENT_IMAGE_REF)=(.*)$/gm, (_, key, ref) => `${key}=${retag(ref)}`);
if (!updatedEnv.includes(`JOSHU_RELEASE_VERSION=${version}`)) fail("deploy/.env.vps.example has no JOSHU_RELEASE_VERSION line");
writeFileSync(envExample, updatedEnv);

console.log(previous);
