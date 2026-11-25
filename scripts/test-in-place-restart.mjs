#!/usr/bin/env node
/**
 * Unit test of the restart of a box in place, for single-container mode (change
 * sandbox-box-commands):
 *   1. the instance agent side (packages/instance-agent/src/inPlaceRestart.ts), with fake files;
 *   2. the desktop password step of the start script (scripts/lib/restart-in-place.sh), with a
 *      fake password helper;
 *   3. on Linux only, the restart itself: a start script that gets SIGUSR1 stops the processes
 *      under it and starts again with the environment that it started with.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AROZ_PASSWORD_RESULT_PATH,
  finishPendingRestart,
  hasPendingRestart,
  PENDING_AROZ_PASSWORD_PATH,
  PENDING_RESTART_PATH,
  requestRestart,
  RESTART_READY_PATH,
  STARTED_AT_PATH,
} from "../packages/instance-agent/src/inPlaceRestart.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(root, "scripts", "lib", "restart-in-place.sh");

function fakeFs(files = {}) {
  const state = new Map(Object.entries(files));
  const log = [];
  return {
    state,
    log,
    deps: {
      exists: async (p) => state.has(p),
      readText: async (p) => (state.has(p) ? state.get(p) : null),
      writePrivate: async (p, text) => void state.set(p, text),
      remove: async (p) => void state.delete(p),
      signalRestart: () => void log.push("SIGUSR1"),
      sleep: async (ms) => void log.push(`sleep ${ms}`),
      now: () => new Date("2026-11-20T20:00:00.000Z"),
    },
  };
}

const cmd = { id: "cmd-1", type: "rotate_secrets", issuedAt: "2026-11-20T19:59:00.000Z" };

// 1a. No ready file: the start script cannot restart in place. Nothing is written, no signal,
// and the changes of the command (here the new secrets) do not run.
{
  const f = fakeFs();
  let changed = false;
  await assert.rejects(
    requestRestart(cmd, f.deps, { waitMs: 600_000, before: async () => void (changed = true) }),
    /cannot restart in place/,
  );
  assert.equal(f.state.size, 0);
  assert.deepEqual(f.log, []);
  assert.equal(changed, false, "the secrets are not written when the box cannot restart in place");
  const ready = fakeFs({ [RESTART_READY_PATH]: "" });
  await assert.rejects(requestRestart(cmd, ready.deps, { waitMs: 1, before: async () => void (changed = true) }));
  assert.equal(changed, true, "with the ready file the secrets are written before the restart");
}

// 1b. Ready: the agent writes the pending command, signals process 1, and waits. When this
// agent still runs after the wait, the restart did not start: the pending files go, and the
// command fails.
{
  const f = fakeFs({ [RESTART_READY_PATH]: "" });
  const password = { user: "owner@example.com", hash: "a".repeat(128) };
  await assert.rejects(
    requestRestart({ ...cmd, type: "set_aroz_password" }, f.deps, { waitMs: 600_000, password }),
    /did not restart within 600 seconds; the restart is cancelled/,
  );
  assert.deepEqual(f.log, ["SIGUSR1", "sleep 600000"]);
  assert.equal(f.state.has(PENDING_RESTART_PATH), false);
  assert.equal(f.state.has(PENDING_AROZ_PASSWORD_PATH), false);
}

// 1c. The files before the signal.
{
  const f = fakeFs({ [RESTART_READY_PATH]: "", [AROZ_PASSWORD_RESULT_PATH]: '{"ok":true}' });
  const seen = {};
  f.deps.signalRestart = () => {
    seen.pending = JSON.parse(f.state.get(PENDING_RESTART_PATH));
    seen.password = JSON.parse(f.state.get(PENDING_AROZ_PASSWORD_PATH));
    seen.oldResult = f.state.has(AROZ_PASSWORD_RESULT_PATH);
  };
  const password = { user: "owner@example.com", hash: "b".repeat(128) };
  await assert.rejects(requestRestart({ ...cmd, type: "set_aroz_password" }, f.deps, { waitMs: 1, password }));
  assert.deepEqual(seen.pending, { commandId: "cmd-1", commandType: "set_aroz_password", issuedAt: "2026-11-20T19:59:00.000Z", requestedAt: "2026-11-20T20:00:00.000Z" });
  assert.deepEqual(seen.password, password);
  assert.equal(seen.oldResult, false, "an old result does not count for a new reset");
}

// 1d. After the restart: the agent of the new start acknowledges the command. The start time of
// the box is after the request, so the restart happened.
const after = String(Date.parse("2026-11-20T20:00:30.000Z") / 1000);
const finish = (deps, waitHealthy = async () => {}) => finishPendingRestart(deps, waitHealthy, { waitMs: 600_000 });
{
  const pending = JSON.stringify({ commandId: "cmd-2", commandType: "restart", issuedAt: "x", requestedAt: "2026-11-20T20:00:00.000Z" });
  const f = fakeFs({ [PENDING_RESTART_PATH]: pending, [STARTED_AT_PATH]: after });
  assert.equal(await hasPendingRestart(f.deps), true);
  const outcome = await finish(f.deps);
  assert.deepEqual(outcome, { commandId: "cmd-2", commandType: "restart", status: "succeeded" });
  assert.equal(f.state.has(PENDING_RESTART_PATH), false, "the pending file goes before the health wait, so a crash does not repeat the command");
  assert.equal(await finish(f.deps), null, "nothing pending");

  const unhealthy = fakeFs({ [PENDING_RESTART_PATH]: pending, [STARTED_AT_PATH]: after });
  const failed = await finish(unhealthy.deps, async () => {
    throw new Error("not healthy after 600 seconds");
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /not healthy after the restart: not healthy after 600 seconds/);

  // The agent started again before the box restarted (a crash during the wait): it waits for
  // the rest of the time, and then cancels and fails the command.
  const early = fakeFs({ [PENDING_RESTART_PATH]: pending, [STARTED_AT_PATH]: String(Date.parse("2026-11-20T19:00:00.000Z") / 1000) });
  early.deps.now = () => new Date("2026-11-20T20:01:00.000Z");
  const cancelled = await finish(early.deps);
  assert.deepEqual(early.log, ["sleep 540000"], "the rest of the 600 seconds");
  assert.equal(cancelled.status, "failed");
  assert.match(cancelled.error, /restart is cancelled/);
  assert.equal(early.state.has(PENDING_RESTART_PATH), false);
}

// 1e. A password reset reads the result of the start script.
{
  const pending = JSON.stringify({ commandId: "cmd-3", commandType: "set_aroz_password", issuedAt: "x", requestedAt: "2026-11-20T20:00:00.000Z" });
  const ok = fakeFs({ [PENDING_RESTART_PATH]: pending, [STARTED_AT_PATH]: after, [AROZ_PASSWORD_RESULT_PATH]: '{"ok":true,"error":""}' });
  assert.equal((await finish(ok.deps)).status, "succeeded");
  assert.equal(ok.state.has(AROZ_PASSWORD_RESULT_PATH), false);
  const bad = fakeFs({ [PENDING_RESTART_PATH]: pending, [STARTED_AT_PATH]: after, [AROZ_PASSWORD_RESULT_PATH]: '{"ok":false,"error":"user not found"}' });
  const badOutcome = await finish(bad.deps);
  assert.deepEqual([badOutcome.status, badOutcome.error], ["failed", "the new desktop password was not saved: user not found"]);
  const none = fakeFs({ [PENDING_RESTART_PATH]: pending, [STARTED_AT_PATH]: after, [PENDING_AROZ_PASSWORD_PATH]: "{}" });
  const noneOutcome = await finish(none.deps);
  assert.match(noneOutcome.error, /wrote no result/);
  assert.equal(none.state.has(PENDING_AROZ_PASSWORD_PATH), false, "a password that the start script did not use is removed");
}

// 2. The password step of the start script, with a fake helper.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restart-in-place-"));
  const secrets = path.join(tmp, "secrets");
  const aroz = path.join(tmp, "arozos");
  fs.mkdirSync(secrets);
  fs.mkdirSync(path.join(aroz, "system"), { recursive: true });
  const helper = path.join(tmp, "helper.sh");
  const record = path.join(tmp, "helper-call");
  // The fake helper records its arguments and the hash it got, and fails for user "nobody".
  fs.writeFileSync(helper, `#!/usr/bin/env bash\necho "$* hash=$AO_PW_HASH" > "${record}"\nif [[ "$*" == *nobody* ]]; then echo "user nobody not found" >&2; exit 1; fi\n`, { mode: 0o755 });
  const run = (pending, extraEnv = {}) => {
    if (pending) fs.writeFileSync(path.join(secrets, "pending-aroz-password.json"), JSON.stringify(pending));
    const done = spawnSync("bash", ["-c", `set -euo pipefail; source "${lib}"; apply_pending_aroz_password`], {
      env: { ...process.env, JOSHU_SECRETS_DIR: secrets, AROZ_DATA: aroz, JOSHU_AROZ_RESET_PASSWORD_BIN: helper, ...extraEnv },
      encoding: "utf8",
    });
    assert.equal(done.status, 0, done.stderr);
    const resultFile = path.join(secrets, "aroz-password-result.json");
    const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null;
    fs.rmSync(resultFile, { force: true });
    return result;
  };
  const hash = "c".repeat(128);
  assert.deepEqual(run({ user: "owner@example.com", hash }), { ok: true, error: "" });
  assert.equal(fs.readFileSync(record, "utf8").trim(), `-db ${aroz}/system/ao.db -user owner@example.com hash=${hash}`, "the hash goes in the environment, not in the arguments");
  assert.equal(fs.existsSync(path.join(secrets, "pending-aroz-password.json")), false, "the pending password is removed");
  const failed = run({ user: "nobody", hash });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /user nobody not found/);
  assert.equal(run({ user: "owner@example.com", hash }, { JOSHU_AROZ_RESET_PASSWORD_BIN: path.join(tmp, "missing") }).error.includes("is missing"), true);
  assert.equal(run(null), null, "no pending password, no result");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. The restart itself, on Linux (it reads /proc).
if (fs.existsSync("/proc/self/environ")) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restart-in-place-"));
  const box = path.join(tmp, "box.sh");
  fs.mkdirSync(path.join(tmp, "secrets"));
  // A small start script: the first start keeps two processes running and changes a variable,
  // then asks for a restart. The second start checks that the processes are gone and that the
  // variable has its value from the first environment, and ends.
  fs.writeFileSync(
    box,
    `#!/usr/bin/env bash
set -euo pipefail
source "${lib}"
T="${tmp}"
echo start >> "$T/starts"
trap restart_in_place USR1
if [[ "$(wc -l < "$T/starts")" -eq 1 ]]; then
  # A signal with no pending command does nothing: the agent cancelled it.
  kill -USR1 $$
  sleep 0.2
  [[ "$(wc -l < "$T/starts")" -eq 1 ]] || { echo "restart with no pending command" > "$T/error"; exit 1; }
  echo '{"commandId":"c"}' > "$T/secrets/pending-restart-command.json"
  ( sleep 300 ) &
  echo $! > "$T/child1"
  bash -c 'sleep 300 & echo $! > "'"$T"'/grandchild"; wait' &
  export BOX_SECRET=changed
  sleep 0.3
  kill -USR1 $$
  sleep 30 &
  wait $!
  echo "no restart" > "$T/error"
  exit 1
fi
for f in child1 grandchild; do
  if kill -0 "$(cat "$T/$f")" 2>/dev/null; then echo "$f still runs" > "$T/error"; fi
done
echo "BOX_SECRET=\${BOX_SECRET:-}" > "$T/env"
`,
    { mode: 0o755 },
  );
  const started = Date.now();
  const child = spawn("bash", [box], { env: { PATH: process.env.PATH, BOX_SECRET: "original", JOSHU_SECRETS_DIR: path.join(tmp, "secrets") }, stdio: "ignore" });
  const code = await new Promise((done) => child.on("exit", done));
  assert.equal(code, 0, fs.existsSync(path.join(tmp, "error")) ? fs.readFileSync(path.join(tmp, "error"), "utf8") : "the box script failed");
  assert.equal(fs.readFileSync(path.join(tmp, "starts"), "utf8").trim().split("\n").length, 2, "the script started two times");
  assert.equal(fs.existsSync(path.join(tmp, "error")), false, fs.existsSync(path.join(tmp, "error")) ? fs.readFileSync(path.join(tmp, "error"), "utf8") : "");
  assert.equal(fs.readFileSync(path.join(tmp, "env"), "utf8").trim(), "BOX_SECRET=original", "the new start has the environment of the first start");
  assert.equal(child.pid !== undefined, true);
  assert.ok(Date.now() - started < 15_000, `the restart does not wait for the full stop time (took ${Date.now() - started} ms)`);
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log("note: no /proc here, so the restart itself did not run (it runs in CI on Linux)");
}

console.log("in-place restart: all checks passed");
