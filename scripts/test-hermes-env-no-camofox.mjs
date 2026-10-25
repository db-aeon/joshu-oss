#!/usr/bin/env npx tsx
/**
 * Hermes gets no Camofox setting (change remove-camofox): the dotenv sync drops
 * CAMOFOX_* and HITL_CAMOFOX_* keys from ~/.hermes/.env, and the environment of
 * the Hermes gateway has no such key.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const home = await mkdtemp(path.join(tmpdir(), "joshu-hermes-home-"));
process.env.HERMES_HOME = home;

const { hermesProcessEnv, syncHermesDotenv } = await import("../src/hermesApi.ts");

try {
  const envPath = path.join(home, ".env");
  await writeFile(
    envPath,
    [
      "OPENROUTER_API_KEY=sk-test",
      "CAMOFOX_URL=http://127.0.0.1:9377",
      "CAMOFOX_USER_ID=hitl-camofox",
      "HITL_CAMOFOX_SESSION_KEY=hitl-main",
      "BROWSER_CDP_URL=http://127.0.0.1:9222",
      "",
    ].join("\n"),
    "utf8",
  );

  // Box upgraded from release 0.1.49: the old keys go, the other keys stay.
  assert.equal(await syncHermesDotenv({ BROWSER_CDP_URL: "http://127.0.0.1:9333", CAMOFOX_URL: "x" }), true);
  const body = await readFile(envPath, "utf8");
  assert.doesNotMatch(body, /^(CAMOFOX_|HITL_CAMOFOX_)/m, "no Camofox key in ~/.hermes/.env");
  assert.match(body, /^OPENROUTER_API_KEY=sk-test$/m);
  assert.match(body, /^BROWSER_CDP_URL=http:\/\/127\.0\.0\.1:9333$/m);

  // A second sync with the same entries changes nothing.
  assert.equal(await syncHermesDotenv({ BROWSER_CDP_URL: "http://127.0.0.1:9333" }), false);

  // The gateway environment drops the Camofox keys of the Joshu API process.
  const env = hermesProcessEnv({ PATH: "/usr/bin", CAMOFOX_URL: "http://127.0.0.1:9377", HITL_CAMOFOX_USER_ID: "u" });
  assert.deepEqual(env, { PATH: "/usr/bin" });

  console.log("hermes-env-no-camofox: ok");
} finally {
  await rm(home, { recursive: true, force: true });
}
