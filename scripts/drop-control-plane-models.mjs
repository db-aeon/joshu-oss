#!/usr/bin/env node
/**
 * Drop the model lines that the control plane wrote from instance.env (changes
 * release-hermes-model and release-hindsight-model).
 *
 * The start script calls this in single-container mode, before anything reads instance.env.
 * Such a box gets a release by a rebuild of its container, so no instance agent runs a release
 * update there. On a Compose host the instance agent removes the same lines in the release
 * update (packages/instance-agent/src/releaseEnv.ts).
 *
 * Usage: node drop-control-plane-models.mjs [--file /etc/joshu/instance.env]
 * Environment:
 *   APP_DIR                           Root of the image (default /opt/joshu); the rule is in
 *                                     <APP_DIR>/dist/joshuOpenRouterDefaults.js.
 *   JOSHU_OPENROUTER_DEFAULTS_MODULE  Path of that module, for the test.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fileArg = process.argv.indexOf("--file");
const file = fileArg > 0 && process.argv[fileArg + 1] ? process.argv[fileArg + 1] : "/etc/joshu/instance.env";
const modulePath =
  process.env.JOSHU_OPENROUTER_DEFAULTS_MODULE ||
  path.join(process.env.APP_DIR || "/opt/joshu", "dist", "joshuOpenRouterDefaults.js");
const { controlPlaneEnvRemovals } = await import(pathToFileURL(modulePath).href);

let text = "";
try {
  text = await readFile(file, "utf8");
} catch {
  process.exit(0);
}
const current = {};
for (const line of text.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (match) current[match[1]] = match[2].replace(/^"|"$/g, "");
}
const removals = controlPlaneEnvRemovals(current);
if (removals.length > 0) {
  const patch = path.join(path.dirname(fileURLToPath(import.meta.url)), "patch-instance-env.mjs");
  execFileSync("node", [patch, "--file", file, ...removals.flatMap((key) => ["--unset", key])], { stdio: "inherit" });
  console.log(`[drop-control-plane-models] removed ${removals.join(", ")} from ${file}; the box runs the models of its release`);
}
