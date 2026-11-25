/**
 * loadEnv skips ~/.hermes/.env when VOICE_REALTIME_SKIP_HERMES_ENV=1
 * (change single-container-mode), so the voice service inside the stack container sees
 * the same values as the voice container of a Compose host.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const loadEnvUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "loadEnv.js"),
).href;

function valueAfterLoadEnv(extraEnv) {
  const hermesHome = mkdtempSync(path.join(tmpdir(), "voice-loadenv-"));
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(path.join(hermesHome, ".env"), "VOICE_LOADENV_PROBE=from-hermes\n");
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(loadEnvUrl)}); process.stdout.write(process.env.VOICE_LOADENV_PROBE ?? "")`],
    { env: { PATH: process.env.PATH, HERMES_HOME: hermesHome, VOICE_LOADENV_PROBE: "from-env", ...extraEnv }, encoding: "utf8" },
  );
}

test("loadEnv reads ~/.hermes/.env by default", () => {
  assert.equal(valueAfterLoadEnv({}), "from-hermes");
});

test("loadEnv skips ~/.hermes/.env in single-container mode", () => {
  assert.equal(valueAfterLoadEnv({ VOICE_REALTIME_SKIP_HERMES_ENV: "1" }), "from-env");
});
