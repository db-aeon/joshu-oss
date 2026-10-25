#!/usr/bin/env node
/**
 * Unit tests: deploy/scripts/prune-release-images.sh (change prune-release-images).
 * A fake `docker` on PATH serves a list of images and containers from a JSON file
 * and records each command, so the test runs offline with no Docker.
 *
 * Usage: npm run test:prune-release-images
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "deploy/scripts/prune-release-images.sh");

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, args.join(" ") + "\\n");
const byRef = (ref) => state.images.find((i) => i.repo + ":" + i.tag === ref || i.repo + "@" + i.digest === ref);
const out = (s) => s && process.stdout.write(s + "\\n");
const [a, b] = args;
if (a === "ps") out(state.containers.map((c) => c.id).join("\\n"));
else if (a === "inspect") out((state.containers.find((c) => c.id === args[args.length - 1]) || {}).image);
else if (a === "image" && b === "inspect") {
  const image = byRef(args[args.length - 1]);
  if (!image) process.exit(1);
  out(image.id);
} else if (a === "image" && b === "ls" && args.includes("dangling=true")) out("");
else if (a === "image" && b === "ls") {
  const repo = args[args.length - 1];
  out(state.images.filter((i) => i.repo === repo).map((i) => i.created + "|" + i.id + "|" + i.tag).join("\\n"));
} else if (a === "image" && b === "rm") {
  const target = args[2];
  const image = byRef(target) || state.images.find((i) => i.id === target);
  if (!image || state.containers.some((c) => c.image === image.id)) process.exit(1);
} else if (a === "image" && b === "prune") {
} else process.exit(2);
`;

const SANDBOX = "ghcr.io/db-aeon/joshu-sandbox";
const VOICE = "ghcr.io/db-aeon/joshu-voice-realtime";
const AGENT = "ghcr.io/db-aeon/joshu-instance-agent";

function image(repo, tag, n) {
  return { repo, tag, id: `sha256:${repo.slice(-5)}${tag}`, created: `2026-10-${String(n).padStart(2, "0")} 10:00:00 +0000 UTC` };
}

function releaseImages(...releases) {
  return releases.flatMap(([tag, day]) => [image(SANDBOX, tag, day), image(VOICE, tag, day), image(AGENT, tag, day)]);
}

function currentEnv(tag) {
  return {
    JOSHU_IMAGE_REF: `${SANDBOX}:${tag}`,
    JOSHU_VOICE_IMAGE_REF: `${VOICE}:${tag}`,
    JOSHU_INSTANCE_AGENT_IMAGE_REF: `${AGENT}:${tag}`,
  };
}

function run(state, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "prune-release-images-"));
  writeFileSync(path.join(dir, "docker"), FAKE_DOCKER);
  chmodSync(path.join(dir, "docker"), 0o755);
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(path.join(dir, "log"), "");
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: path.join(dir, "state.json"),
      FAKE_DOCKER_LOG: path.join(dir, "log"),
      ENV_FILE: path.join(dir, "missing.env"),
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(path.join(dir, "log"), "utf8").trim().split("\n").filter(Boolean);
  const removed = calls.filter((c) => c.startsWith("image rm ")).map((c) => c.slice("image rm ".length));
  return { calls, removed, stdout: result.stdout, dir };
}

// 1. After an upgrade to 0.1.56: keep 0.1.56 and 0.1.55, remove 0.1.54 and an untagged old sandbox image.
{
  const state = {
    images: [
      ...releaseImages(["0.1.54", 12], ["0.1.55", 13], ["0.1.56", 14]),
      { repo: SANDBOX, tag: "<none>", id: "sha256:oldsandbox", created: "2026-10-01 10:00:00 +0000 UTC" },
      image("postgres", "15-bookworm", 1),
    ],
    containers: [
      { id: "c1", image: image(SANDBOX, "0.1.56", 14).id },
      { id: "c2", image: image(AGENT, "0.1.56", 14).id },
    ],
  };
  const { removed, calls, stdout } = run(state, currentEnv("0.1.56"));
  assert.deepEqual(removed.sort(), [`${AGENT}:0.1.54`, `${SANDBOX}:0.1.54`, `${VOICE}:0.1.54`, "sha256:oldsandbox"].sort());
  assert.ok(calls.includes("image prune -f"), "dangling images are removed");
  assert.ok(stdout.includes(`keep ${SANDBOX}:0.1.55 for a rollback`), stdout);
  assert.ok(!calls.some((c) => c.includes("postgres")), "other repositories are not touched");
  assert.ok(!calls.some((c) => c.startsWith("image rm") && /\s(-f|--force)\b/.test(c)), "never forces");
}

// 2. An image that a stopped container uses stays.
{
  const state = {
    images: releaseImages(["0.1.53", 11], ["0.1.54", 12], ["0.1.55", 13], ["0.1.56", 14]),
    containers: [{ id: "old", image: image(SANDBOX, "0.1.53", 11).id }],
  };
  const { removed } = run(state, currentEnv("0.1.56"));
  assert.ok(!removed.includes(`${SANDBOX}:0.1.53`), "image of a stopped container stays");
  assert.ok(removed.includes(`${SANDBOX}:0.1.54`));
  assert.ok(!removed.includes(`${SANDBOX}:0.1.55`));
}

// 3. After a rollback to 0.1.55: keep 0.1.55 and the newer 0.1.56, remove 0.1.54.
{
  const state = { images: releaseImages(["0.1.54", 12], ["0.1.55", 13], ["0.1.56", 14]), containers: [] };
  const { removed } = run(state, currentEnv("0.1.55"));
  assert.deepEqual(removed.sort(), [`${AGENT}:0.1.54`, `${SANDBOX}:0.1.54`, `${VOICE}:0.1.54`].sort());
}

// 4. The release pins come from ENV_FILE when the environment has none; a digest reference works.
{
  const images = releaseImages(["0.1.54", 12], ["0.1.55", 13], ["0.1.56", 14]);
  images.find((i) => i.repo === SANDBOX && i.tag === "0.1.56").digest = "sha256:abc";
  const dir = mkdtempSync(path.join(tmpdir(), "prune-release-images-env-"));
  const envFile = path.join(dir, "instance.env");
  writeFileSync(
    envFile,
    [`JOSHU_IMAGE_REF="${SANDBOX}@sha256:abc"`, `JOSHU_VOICE_IMAGE_REF=${VOICE}:0.1.56`, `JOSHU_INSTANCE_AGENT_IMAGE_REF=${AGENT}:0.1.56`].join("\n"),
  );
  const { removed } = run({ images, containers: [] }, { ENV_FILE: envFile });
  assert.deepEqual(removed.sort(), [`${AGENT}:0.1.54`, `${SANDBOX}:0.1.54`, `${VOICE}:0.1.54`].sort());
}

// 5. DRY_RUN=1 removes nothing; JOSHU_PRUNE_RELEASE_IMAGES=0 runs no docker command.
{
  const state = { images: releaseImages(["0.1.54", 12], ["0.1.55", 13], ["0.1.56", 14]), containers: [] };
  const dry = run(state, { ...currentEnv("0.1.56"), DRY_RUN: "1" });
  assert.deepEqual(dry.removed, []);
  assert.ok(!dry.calls.includes("image prune -f"));
  assert.ok(dry.stdout.includes(`would remove ${SANDBOX}:0.1.54`), dry.stdout);
  const off = run(state, { ...currentEnv("0.1.56"), JOSHU_PRUNE_RELEASE_IMAGES: "0" });
  assert.deepEqual(off.calls, []);
}

// 6. No release pins at all: remove nothing.
{
  const state = { images: releaseImages(["0.1.54", 12], ["0.1.55", 13]), containers: [] };
  const { calls } = run(state);
  assert.deepEqual(calls, []);
}

console.log("prune-release-images: all tests passed");
