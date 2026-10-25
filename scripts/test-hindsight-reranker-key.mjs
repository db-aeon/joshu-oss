#!/usr/bin/env npx tsx
/**
 * Tests: scripts/start-hindsight.sh gives Hindsight a private copy of the Google
 * reranker key, so the host owner and mode of the key do not matter
 * (clara, 0.1.51 rollout: the key had the hindsight gid of an older image).
 *
 * The test runs start-hindsight.sh with a fake hindsight-api that prints the key
 * path it gets and exits. As root, the script also gives the copy to the
 * Hindsight user; this test runs as the current user, so it checks the copy,
 * the mode, the env value, and the warnings.
 *
 * Usage: npm run test:hindsight-reranker-key
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { userInfo, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "start-hindsight.sh");
const root = await mkdtemp(path.join(tmpdir(), "joshu-hindsight-key-"));

function run(env) {
  const fakeApi = path.join(root, "fake-hindsight-api");
  const log = path.join(root, "hindsight-api.log");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      JOSHU_HINDSIGHT_ENABLED: "true",
      HINDSIGHT_API_LLM_PROVIDER: "gemini",
      HINDSIGHT_API_BIN: fakeApi,
      HINDSIGHT_API_PORT: "1",
      HINDSIGHT_LOG_FILE: log,
      HINDSIGHT_STARTUP_ATTEMPTS: "5",
      ...env,
    },
  });
  return { ...result, keyLine: result.stderr.split("\n").findLast((line) => line.startsWith("KEY=")) };
}

try {
  const fakeApi = path.join(root, "fake-hindsight-api");
  await writeFile(
    fakeApi,
    '#!/usr/bin/env bash\nk="${HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY:-}"\n' +
      'if [[ -n "$k" ]] && cat "$k" >/dev/null 2>&1; then echo "KEY=$k readable"; else echo "KEY=$k unreadable"; fi\nexit 1\n',
  );
  await chmod(fakeApi, 0o755);

  const key = path.join(root, "google-reranker-service-account.json");
  await writeFile(key, '{"type":"service_account"}\n');
  const privateDir = path.join(root, "private");
  const user = userInfo().username;

  // Key set and Hindsight user set: Hindsight gets the private copy, mode 600.
  let r = run({
    HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY: key,
    HINDSIGHT_RUN_AS_USER: user,
    HINDSIGHT_PRIVATE_SECRETS_DIR: privateDir,
  });
  const copy = path.join(privateDir, "google-reranker-service-account.json");
  assert.equal(r.keyLine, `KEY=${copy} readable`, r.stdout + r.stderr);
  assert.match(r.stdout, /private copy for .* at /);
  assert.equal(await readFile(copy, "utf8"), await readFile(key, "utf8"));
  assert.equal((await stat(copy)).mode & 0o777, 0o600);
  assert.equal((await stat(privateDir)).mode & 0o777, 0o700);

  // Second start: the copy is refreshed from the source key.
  await writeFile(key, '{"type":"service_account","rotated":true}\n');
  r = run({
    HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY: key,
    HINDSIGHT_RUN_AS_USER: user,
    HINDSIGHT_PRIVATE_SECRETS_DIR: privateDir,
  });
  assert.equal(r.keyLine, `KEY=${copy} readable`);
  assert.match(await readFile(copy, "utf8"), /rotated/);

  // No Hindsight user (local development): Hindsight reads the key in place.
  r = run({ HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY: key, HINDSIGHT_PRIVATE_SECRETS_DIR: privateDir });
  assert.equal(r.keyLine, `KEY=${key} readable`);

  // No key: nothing to copy and no warning.
  r = run({ HINDSIGHT_RUN_AS_USER: user, HINDSIGHT_PRIVATE_SECRETS_DIR: privateDir });
  assert.equal(r.keyLine, "KEY= unreadable");
  assert.doesNotMatch(r.stderr, /WARNING/);

  // Key that the start script cannot read: a loud warning in the log.
  const missing = path.join(root, "missing.json");
  r = run({
    HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY: missing,
    HINDSIGHT_RUN_AS_USER: user,
    HINDSIGHT_PRIVATE_SECRETS_DIR: privateDir,
  });
  assert.match(r.stderr, /WARNING: cannot read the Google reranker key/);
  assert.equal(r.keyLine, `KEY=${missing} unreadable`);

  console.log("test-hindsight-reranker-key: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
