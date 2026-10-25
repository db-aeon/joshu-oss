#!/usr/bin/env npx tsx
/**
 * Unit tests: instance agent release pins and runtime drift
 * (change image-owned-box-runtime), and the agent replace helper (change agent-self-replace).
 *
 * Usage: npm run test:instance-agent-release
 */
import assert from "node:assert/strict";

import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AGENT_REPLACE_HELPER_NAME,
  agentReplaceRunArgs,
  replaceAgentContainer,
  startInstanceAgent,
} from "../packages/instance-agent/src/agentReplace.js";
import { configHasGhcrAuth, useWritableDockerConfig } from "../packages/instance-agent/src/registryAuth.js";
import { releaseEnvUpdates } from "../packages/instance-agent/src/releaseEnv.js";
import { finishReleaseUpdate } from "../packages/instance-agent/src/releaseFinish.js";
import { evaluateRuntimeDrift } from "../packages/instance-agent/src/runtimeDrift.js";
import {
  instanceAgentImageRefFromSandbox,
  voiceImageRefFromSandbox,
} from "../packages/instance-agent/src/voiceImageRef.js";

// Agent image follows the tag of the sandbox image.
assert.equal(
  instanceAgentImageRefFromSandbox("ghcr.io/db-aeon/joshu-sandbox:0.1.49"),
  "ghcr.io/db-aeon/joshu-instance-agent:0.1.49",
);
assert.equal(
  instanceAgentImageRefFromSandbox("ghcr.io/acme/joshu-oss:latest"),
  "ghcr.io/acme/joshu-oss-instance-agent:latest",
);
assert.equal(
  instanceAgentImageRefFromSandbox("ghcr.io/db-aeon/joshu-sandbox:0.1.49", " ghcr.io/x/agent:7 "),
  "ghcr.io/x/agent:7",
);
// Voice image mapping stays as before.
assert.equal(
  voiceImageRefFromSandbox("ghcr.io/db-aeon/joshu-sandbox:0.1.49"),
  "ghcr.io/db-aeon/joshu-voice-realtime:0.1.49",
);
assert.equal(voiceImageRefFromSandbox("registry/x:1"), "registry/x-voice-realtime:1");

// Release update payload → instance.env pins.
assert.deepEqual(
  releaseEnvUpdates({ imageRef: "ghcr.io/db-aeon/joshu-sandbox:0.1.49", version: "0.1.49" }),
  {
    JOSHU_IMAGE_REF: "ghcr.io/db-aeon/joshu-sandbox:0.1.49",
    JOSHU_RELEASE_VERSION: "0.1.49",
    JOSHU_VOICE_IMAGE_REF: "ghcr.io/db-aeon/joshu-voice-realtime:0.1.49",
    JOSHU_INSTANCE_AGENT_IMAGE_REF: "ghcr.io/db-aeon/joshu-instance-agent:0.1.49",
  },
);
assert.equal(
  releaseEnvUpdates({
    imageRef: "ghcr.io/db-aeon/joshu-sandbox:0.1.49",
    instanceAgentImageRef: "ghcr.io/db-aeon/joshu-instance-agent:0.1.49-fix",
  }).JOSHU_INSTANCE_AGENT_IMAGE_REF,
  "ghcr.io/db-aeon/joshu-instance-agent:0.1.49-fix",
);
assert.deepEqual(releaseEnvUpdates({ hermesRef: "abc" }), { HERMES_AGENT_REF: "abc" });

// Runtime drift: a box on the release of this change, empty hotfix overlay.
const clean = {
  stackMounts: [
    { Type: "bind", Source: "/opt/joshu/hotfix/scripts", Destination: "/opt/joshu/hotfix/scripts" },
    { Type: "bind", Source: "/etc/joshu", Destination: "/etc/joshu" },
    { Type: "volume", Source: "deploy_joshu_hermes", Destination: "/root/.hermes" },
  ],
  hostCheckout: false,
  hotfixFiles: [],
  hostBundleVersion: "0.1.49",
  releaseVersion: "0.1.49",
};
assert.deepEqual(evaluateRuntimeDrift(clean), []);

// Old host compose (alex, 2026-10-07): host code mounted over the image.
assert.deepEqual(
  evaluateRuntimeDrift({
    ...clean,
    stackMounts: [
      ...clean.stackMounts,
      {
        Type: "bind",
        Source: "/opt/joshu/scripts/hermes-kanban-bridge.py",
        Destination: "/opt/joshu/scripts/hermes-kanban-bridge.py",
      },
      { Type: "bind", Source: "/opt/joshu/dist", Destination: "/opt/joshu/dist/" },
    ],
  }).map((i) => i.kind + ":" + i.detail),
  [
    "host_mount:/opt/joshu/scripts/hermes-kanban-bridge.py -> /opt/joshu/scripts/hermes-kanban-bridge.py",
    "host_mount:/opt/joshu/dist -> /opt/joshu/dist/",
  ],
);

// A path that only starts with the same letters is not below /opt/joshu.
assert.deepEqual(
  evaluateRuntimeDrift({
    ...clean,
    stackMounts: [{ Type: "bind", Source: "/x", Destination: "/opt/joshu-design" }],
  }),
  [],
);

// Host checkout, hotfix file, and host bundle from another release.
assert.deepEqual(
  evaluateRuntimeDrift({
    ...clean,
    hostCheckout: true,
    hotfixFiles: ["hermes-kanban-bridge.py"],
    hostBundleVersion: "0.1.48",
  }),
  [
    { kind: "host_checkout", detail: "/opt/joshu/.git exists" },
    { kind: "hotfix_file", detail: "hermes-kanban-bridge.py" },
    { kind: "host_bundle_version", detail: "host bundle 0.1.48, release 0.1.49" },
  ],
);

// No host bundle at all (box before this change).
assert.deepEqual(evaluateRuntimeDrift({ ...clean, hostBundleVersion: null }), [
  { kind: "host_bundle_version", detail: "deploy/.host-bundle.json missing" },
]);

// Stack container not found: no host_mount items from a missing list.
assert.deepEqual(evaluateRuntimeDrift({ ...clean, stackMounts: null }), []);


// Registry login: the host ~/.docker mount is read-only, so the agent works on a writable copy
// of config.json (docker login failed with "read-only file system" in the 0.1.52 canary).
{
  const root = await mkdtemp(path.join(tmpdir(), "agent-docker-"));
  const hostDir = path.join(root, "host");
  const agentDir = path.join(root, "agent");
  await mkdir(hostDir);
  await writeFile(path.join(hostDir, "config.json"), JSON.stringify({ auths: { "ghcr.io": { auth: "x" } } }));
  await chmod(hostDir, 0o555);
  const before = process.env.DOCKER_CONFIG;
  await useWritableDockerConfig(hostDir, agentDir);
  assert.equal(process.env.DOCKER_CONFIG, agentDir);
  assert.deepEqual(JSON.parse(await readFile(path.join(agentDir, "config.json"), "utf8")).auths["ghcr.io"], { auth: "x" });
  assert.equal(await configHasGhcrAuth(), true);
  // docker login writes the copy, not the read-only host file.
  await writeFile(path.join(agentDir, "config.json"), JSON.stringify({ auths: {} }));
  assert.equal(await configHasGhcrAuth(), false);
  await chmod(hostDir, 0o755);
  if (before === undefined) delete process.env.DOCKER_CONFIG;
  else process.env.DOCKER_CONFIG = before;
}

// Old release images are removed only after the health wait passed (change prune-release-images).
{
  const calls = [];
  const steps = {
    waitForHealthy: async () => calls.push("health"),
    recreateVoice: async () => calls.push("voice"),
    pruneImages: async () => calls.push("prune"),
  };
  await finishReleaseUpdate(steps);
  assert.deepEqual(calls, ["health", "voice", "prune"]);

  calls.length = 0;
  await finishReleaseUpdate({ ...steps, recreateVoice: undefined });
  assert.deepEqual(calls, ["health", "prune"]);

  calls.length = 0;
  const unhealthy = {
    ...steps,
    waitForHealthy: async () => {
      throw new Error("stack not healthy within 600s after update");
    },
  };
  await assert.rejects(finishReleaseUpdate(unhealthy), /not healthy/);
  assert.deepEqual(calls, [], "an unhealthy stack keeps the old release images");
}

// Agent replace helper (change agent-self-replace): compose runs outside the old agent container.
const replaceOpts = {
  agentImageRef: "ghcr.io/db-aeon/joshu-instance-agent:0.1.58",
  composeFile: "/opt/joshu/deploy/docker-compose.yml",
  composeEnvFile: "/etc/joshu/instance.env",
  installDir: "/opt/joshu",
  composeProfiles: "fleet,voice-rt",
  timeoutMs: 10_000,
  pollMs: 2_000,
};
{
  const args = agentReplaceRunArgs(replaceOpts);
  assert.deepEqual(args.slice(0, 4), ["run", "-d", "--name", AGENT_REPLACE_HELPER_NAME]);
  assert.ok(!args.includes("--rm"), "the helper stays, so a failed replace can read its log");
  assert.ok(!args.some((a) => a.startsWith("--restart")));
  const mounts = args.filter((_, i) => args[i - 1] === "-v");
  assert.deepEqual(mounts, [
    "/var/run/docker.sock:/var/run/docker.sock",
    "/opt/joshu:/opt/joshu:ro",
    "/etc/joshu:/etc/joshu:ro",
  ]);
  const envs = args.filter((_, i) => args[i - 1] === "-e");
  assert.deepEqual(envs, ["JOSHU_COMPOSE_ENV_FILE=/etc/joshu/instance.env", "COMPOSE_PROFILES=fleet,voice-rt"]);
  const image = args.indexOf(replaceOpts.agentImageRef);
  assert.equal(args[image - 1], "docker", "entrypoint docker");
  assert.equal(args[image - 2], "--entrypoint");
  assert.deepEqual(args.slice(image + 1), [
    "compose", "-f", "/opt/joshu/deploy/docker-compose.yml", "--env-file", "/etc/joshu/instance.env",
    "up", "-d", "--no-deps", "--force-recreate", "instance-agent",
  ]);
  // A compose file outside the install folder gets its own mount.
  const outside = agentReplaceRunArgs({ ...replaceOpts, composeFile: "/srv/deploy/docker-compose.yml", composeProfiles: undefined });
  assert.ok(outside.includes("/srv/deploy:/srv/deploy:ro"));
  assert.ok(!outside.some((a) => a.startsWith("COMPOSE_PROFILES=")));
}

/** Fake docker: `inspect` answers from a list of states; the clock moves with sleep. */
function fakeReplaceDeps({ states, runFails = false }) {
  const calls = [];
  let clock = 0;
  let polls = 0;
  const deps = {
    calls,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
    docker: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "run" && runFails) throw new Error("docker run failed: no such image");
      if (args[0] === "inspect") {
        const state = states[Math.min(polls++, states.length - 1)];
        if (state === "missing") throw new Error("No such container");
        return `${state}\n`;
      }
      if (args[0] === "logs") return "Error response from daemon: Conflict. The container name is already in use\n";
      return "";
    },
  };
  return deps;
}

// Helper exits while the old agent still runs: fail with the log, remove the helper.
{
  const deps = fakeReplaceDeps({ states: ["running 0", "exited 1"] });
  await assert.rejects(replaceAgentContainer(replaceOpts, deps), /helper ended \(exited, exit 1\).*Conflict/);
  assert.equal(deps.calls[0], `rm -f ${AGENT_REPLACE_HELPER_NAME}`, "an old helper is removed first");
  assert.ok(deps.calls[1].startsWith("run -d"));
  assert.equal(deps.calls.at(-1), `rm -f ${AGENT_REPLACE_HELPER_NAME}`);
  assert.ok(deps.calls.some((c) => c.startsWith("logs --tail 40")));
}

// Helper that is gone (removed by someone else) counts as ended.
{
  const deps = fakeReplaceDeps({ states: ["missing"] });
  await assert.rejects(replaceAgentContainer(replaceOpts, deps), /helper ended \(missing\)/);
}

// Helper that hangs: fail after the timeout.
{
  const deps = fakeReplaceDeps({ states: ["running 0"] });
  await assert.rejects(replaceAgentContainer(replaceOpts, deps), /still ran after 10s/);
  assert.equal(deps.calls.filter((c) => c.startsWith("inspect")).length, 5);
  assert.equal(deps.calls.at(-1), `rm -f ${AGENT_REPLACE_HELPER_NAME}`);
}

// docker run fails: no wait.
{
  const deps = fakeReplaceDeps({ states: ["running 0"], runFails: true });
  await assert.rejects(replaceAgentContainer(replaceOpts, deps), /no such image/);
  assert.ok(!deps.calls.some((c) => c.startsWith("inspect")));
}

// Start order: a pending update file skips register (status bootstrapping during the update).
{
  const calls = [];
  const steps = (pending) => ({
    hasPendingUpdate: async () => pending,
    register: async () => calls.push("register"),
    resumePendingUpdate: async () => calls.push("resume"),
    removeHelper: async () => calls.push("remove-helper"),
    startHeartbeat: async () => calls.push("heartbeat"),
  });
  await startInstanceAgent(steps(true));
  assert.deepEqual(calls, ["resume", "remove-helper", "heartbeat"]);
  calls.length = 0;
  await startInstanceAgent(steps(false));
  assert.deepEqual(calls, ["register", "heartbeat"]);
}

console.log("instance-agent-release: all tests passed");
