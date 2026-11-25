#!/usr/bin/env npx tsx
/**
 * Tests: the release owns the Hermes model and the Hindsight model (changes
 * release-hermes-model and release-hindsight-model).
 *
 * - Each fallback model in the shell scripts and in the voice service equals
 *   JOSHU_OPENROUTER_DEFAULT_MODEL, so one release runs one model.
 * - The fallback of scripts/start-hindsight.sh equals JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL.
 * - The instance agent and the Joshu API use the same lists of old control plane models, and
 *   the same removal rule.
 * - A release update removes JOSHU_HERMES_MODEL and HINDSIGHT_API_LLM_MODEL only when they name
 *   an old control plane model.
 * - patch-instance-env.mjs --unset removes a key and keeps the other lines.
 * - drop-control-plane-models.mjs (single-container mode) removes the same lines from a file.
 *
 * Usage: npm run test:release-hermes-model
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_PLANE_HERMES_MODELS,
  CONTROL_PLANE_HINDSIGHT_LLM_MODELS,
  JOSHU_OPENROUTER_DEFAULT_MODEL,
  JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL,
  controlPlaneEnvRemovals,
} from "../src/joshuOpenRouterDefaults.ts";
import {
  CONTROL_PLANE_HERMES_MODELS as AGENT_MODELS,
  CONTROL_PLANE_HINDSIGHT_LLM_MODELS as AGENT_HINDSIGHT_MODELS,
  releaseEnvRemovals,
} from "../packages/instance-agent/src/releaseEnv.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1. One model for the release.
const fallbacks = [
  ["deploy/scripts/vps-start.sh", /JOSHU_HERMES_MODEL:-([^}"]+)\}/g],
  ["scripts/fix-hermes-gateway-on-vps.sh", /JOSHU_HERMES_MODEL:-([^}"]+)\}/g],
  ["packages/voice-realtime/src/config.ts", /envTrim\("JOSHU_HERMES_MODEL", "([^"]+)"\)/g],
];
for (const [file, pattern] of fallbacks) {
  const text = await readFile(path.join(root, file), "utf8");
  const found = [...text.matchAll(pattern)].map((m) => m[1]);
  assert.ok(found.length > 0, `${file}: no JOSHU_HERMES_MODEL fallback found`);
  for (const model of found) {
    assert.equal(model, JOSHU_OPENROUTER_DEFAULT_MODEL, `${file}: fallback ${model} is not the release model`);
  }
}

// The Hindsight launcher falls back to the release Hindsight model.
{
  const text = await readFile(path.join(root, "scripts/start-hindsight.sh"), "utf8");
  const found = [...text.matchAll(/export HINDSIGHT_API_LLM_MODEL="([^"$]+)"/g)].map((m) => m[1]);
  assert.deepEqual(found, [JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL], "scripts/start-hindsight.sh: fallback is not the release Hindsight model");
}

// The release models are not control plane models, or the box would drop its own release value.
assert.ok(!CONTROL_PLANE_HERMES_MODELS.includes(JOSHU_OPENROUTER_DEFAULT_MODEL));
assert.ok(!CONTROL_PLANE_HINDSIGHT_LLM_MODELS.includes(JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL));

// 2. Same lists in the agent and in the Joshu API.
assert.deepEqual([...AGENT_MODELS], [...CONTROL_PLANE_HERMES_MODELS]);
assert.deepEqual([...AGENT_HINDSIGHT_MODELS], [...CONTROL_PLANE_HINDSIGHT_LLM_MODELS]);

// 3. Release update removals.
assert.deepEqual(releaseEnvRemovals({ JOSHU_HERMES_MODEL: "deepseek/deepseek-v4-flash-0731" }), ["JOSHU_HERMES_MODEL"]);
assert.deepEqual(releaseEnvRemovals({ JOSHU_HERMES_MODEL: "deepseek/deepseek-v4.1-flash" }), ["JOSHU_HERMES_MODEL"]);
assert.deepEqual(releaseEnvRemovals({ JOSHU_HERMES_MODEL: "~anthropic/claude-sonnet-latest" }), []);
assert.deepEqual(releaseEnvRemovals({}), []);
const OR = { HINDSIGHT_API_LLM_PROVIDER: "openrouter" };
assert.deepEqual(releaseEnvRemovals({ ...OR, HINDSIGHT_API_LLM_MODEL: "google/gemini-3.1-flash-lite" }), ["HINDSIGHT_API_LLM_MODEL"]);
assert.deepEqual(releaseEnvRemovals({ ...OR, HINDSIGHT_API_LLM_MODEL: "gpt-4o-mini" }), []);
// Another provider, or no provider line: the start script has no fallback there, so the line stays.
assert.deepEqual(releaseEnvRemovals({ HINDSIGHT_API_LLM_MODEL: "google/gemini-3.1-flash-lite" }), []);
assert.deepEqual(releaseEnvRemovals({ HINDSIGHT_API_LLM_PROVIDER: "gemini", HINDSIGHT_API_LLM_MODEL: "google/gemini-3.1-flash-lite" }), []);
assert.deepEqual(
  releaseEnvRemovals({ ...OR, JOSHU_HERMES_MODEL: "deepseek/deepseek-v4.1-flash", HINDSIGHT_API_LLM_MODEL: "google/gemini-3.1-flash-lite" }),
  ["JOSHU_HERMES_MODEL", "HINDSIGHT_API_LLM_MODEL"],
);
// The Joshu API copy of the rule (single-container mode) gives the same answer as the agent.
for (const env of [
  {},
  { JOSHU_HERMES_MODEL: "deepseek/deepseek-v4-flash-0731" },
  { ...OR, JOSHU_HERMES_MODEL: "~anthropic/claude-sonnet-latest", HINDSIGHT_API_LLM_MODEL: "google/gemini-3.1-flash-lite" },
  { HINDSIGHT_API_LLM_MODEL: "google/gemini-3.1-flash-lite" },
  { ...OR, JOSHU_HERMES_MODEL: JOSHU_OPENROUTER_DEFAULT_MODEL, HINDSIGHT_API_LLM_MODEL: JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL },
]) {
  assert.deepEqual(controlPlaneEnvRemovals(env), releaseEnvRemovals(env));
}

// 4. patch-instance-env.mjs --unset.
const dir = await mkdtemp(path.join(tmpdir(), "joshu-release-model-"));
const envFile = path.join(dir, "instance.env");
await writeFile(envFile, "A=1\nJOSHU_HERMES_MODEL=deepseek/deepseek-v4.1-flash\n# note\nB=2\n");
execFileSync("node", [path.join(root, "scripts/patch-instance-env.mjs"), "--file", envFile, "--unset", "JOSHU_HERMES_MODEL"]);
assert.equal(await readFile(envFile, "utf8"), "A=1\n# note\nB=2\n");
execFileSync("node", [path.join(root, "scripts/patch-instance-env.mjs"), "--file", envFile, "--unset", "MISSING", "C=3"]);
assert.deepEqual((await readFile(envFile, "utf8")).split("\n").filter(Boolean), ["A=1", "# note", "B=2", "C=3"]);

// 5. drop-control-plane-models.mjs: the start step of single-container mode.
const boxEnv = path.join(dir, "box.env");
await writeFile(
  boxEnv,
  "OPENROUTER_API_KEY=x\nJOSHU_HERMES_MODEL=deepseek/deepseek-v4.1-flash\nHINDSIGHT_API_LLM_PROVIDER=openrouter\nHINDSIGHT_API_LLM_MODEL=google/gemini-3.1-flash-lite\n",
);
const dropEnv = { ...process.env, JOSHU_OPENROUTER_DEFAULTS_MODULE: path.join(root, "src/joshuOpenRouterDefaults.ts") };
const drop = () => execFileSync("npx", ["tsx", path.join(root, "scripts/drop-control-plane-models.mjs"), "--file", boxEnv], { env: dropEnv });
drop();
assert.equal(await readFile(boxEnv, "utf8"), "OPENROUTER_API_KEY=x\nHINDSIGHT_API_LLM_PROVIDER=openrouter\n");
await writeFile(boxEnv, "JOSHU_HERMES_MODEL=~anthropic/claude-sonnet-latest\nHINDSIGHT_API_LLM_MODEL=gpt-4o-mini\n");
drop();
assert.equal(await readFile(boxEnv, "utf8"), "JOSHU_HERMES_MODEL=~anthropic/claude-sonnet-latest\nHINDSIGHT_API_LLM_MODEL=gpt-4o-mini\n");

console.log("ok release hermes model");
