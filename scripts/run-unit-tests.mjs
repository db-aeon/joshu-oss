#!/usr/bin/env node
/**
 * Runs the unit tests: each `test:*` script in package.json, except the scripts in EXCLUDED,
 * and then the `test` script of each workspace package (packages/*).
 *
 *   npm test                         # build once, then run all tests
 *   npm test -- --no-build           # use the current dist/
 *   npm test -- owner-reply teams    # run only the test:* scripts whose name contains a filter
 *
 * The CI workflow .github/workflows/unit-tests.yml runs `npm test` on each pull request.
 * A new `test:*` script runs in CI automatically. It must pass offline, with no secrets
 * and no box. If it cannot, add it to EXCLUDED with the reason.
 *
 * Many scripts start with `npm run build && ...`. This runner builds one time and removes
 * that prefix, so the tests do not build again.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Scripts that CI does not run, with the reason. */
const EXCLUDED = {
  "test:excalidraw-cwm-backend":
    "broken: decision proposals apply at once instead of REQUIRE_CONFIRMATION (issue #93)",
  "test:filesystem-brain": "needs a box: an ArozOS user and JOSHU_FILES_ROOT",
};

const BUILD_PREFIX = "npm run build && ";

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const filters = args.filter((arg) => !arg.startsWith("--"));

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const tests = Object.entries(pkg.scripts)
  .filter(([name]) => name.startsWith("test:") && !(name in EXCLUDED))
  .filter(([name]) => filters.length === 0 || filters.some((f) => name.includes(f)));

function run(label, command) {
  const started = Date.now();
  const result = spawnSync(command, { cwd: root, shell: true, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"} ${label} (${seconds}s)`);
  return ok;
}

if (!noBuild && !run("build", "npm run build")) process.exit(1);

const failed = [];
for (const [name, command] of tests) {
  console.log(`\n=== ${name}`);
  const body = command.startsWith(BUILD_PREFIX) ? command.slice(BUILD_PREFIX.length) : command;
  if (!run(name, body)) failed.push(name);
}

let total = tests.length;
if (filters.length === 0) {
  console.log("\n=== workspace packages");
  total += 1;
  if (!run("workspace packages", "npm test --workspaces --if-present")) failed.push("workspace packages");
}

console.log(`\n${total - failed.length}/${total} test runs passed.`);
for (const [name, reason] of Object.entries(EXCLUDED)) console.log(`not run: ${name} (${reason})`);
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
