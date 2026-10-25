#!/usr/bin/env npx tsx
/**
 * Unit test: Joshu pins the Composio toolkit versions of Gmail, OneNote, Google Calendar, and
 * Slackbot, and each JOSHU_COMPOSIO_*_VERSION environment variable overrides its pin. The test
 * also fails when a file in src/ skips the version check of Composio (dangerouslySkipVersionCheck).
 * A pin keeps a schema change on the Composio side from reaching the boxes without a release.
 *
 * Usage: npm run test:composio-toolkit-pins
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PINS = [
  ["gmailConfig.ts", "COMPOSIO_GMAIL_TOOLKIT_VERSION", "JOSHU_COMPOSIO_GMAIL_TOOLKIT_VERSION", "20260506_01"],
  ["onenoteConfig.ts", "COMPOSIO_ONENOTE_TOOLKIT_VERSION", "JOSHU_COMPOSIO_ONENOTE_TOOLKIT_VERSION", "20260507_00"],
  [
    "googleCalendarConfig.ts",
    "COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION",
    "JOSHU_COMPOSIO_GOOGLECALENDAR_VERSION",
    "20261009_00",
  ],
  ["slackbotConfig.ts", "COMPOSIO_SLACKBOT_TOOLKIT_VERSION", "JOSHU_COMPOSIO_SLACKBOT_TOOLKIT_VERSION", "20261008_00"],
];

const configDir = fileURLToPath(new URL("../src/connectors/composio/", import.meta.url));

/** Read the exported version in a fresh process, so that the environment applies at import. */
function readVersion(file, exportName, env) {
  const script = `import(${JSON.stringify(configDir + file)}).then((m) => process.stdout.write(m.${exportName}))`;
  return execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
    env: { ...env, PATH: process.env.PATH },
    encoding: "utf8",
  });
}

for (const [file, exportName, envName, pin] of PINS) {
  assert.equal(readVersion(file, exportName, {}), pin, `${exportName} default`);
  assert.equal(
    readVersion(file, exportName, { [envName]: " 20990101_00 " }),
    "20990101_00",
    `${envName} overrides ${exportName}`,
  );
  assert.equal(readVersion(file, exportName, { [envName]: "   " }), pin, `${envName} with only spaces keeps the pin`);
}

// No direct Composio call may skip the version check (spec composio-toolkit-versions).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sources = execFileSync("git", ["ls-files", "src"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file));
const skipping = sources.filter((file) =>
  /dangerouslySkipVersionCheck\s*:\s*true/.test(readFileSync(repoRoot + file, "utf8")),
);
assert.deepEqual(skipping, [], `these files skip the Composio version check: ${skipping.join(", ")}`);

console.log("test-composio-toolkit-pins: ok");
