#!/usr/bin/env npx tsx
/**
 * Change pid-file-kill-check: a box script stops the PID of a PID file only when the command
 * line of the process matches the expected command. Otherwise the script removes only the PID
 * file. On 2026-10-10 a stale gbrain-mcp-http.pid named the PID of hindsight-api after a restart
 * of the stack container, and scripts/stop-gbrain.sh killed Hindsight.
 *
 * The test starts dummy processes, writes their PIDs to PID files, runs the real scripts, and
 * checks which dummy processes are still running. It runs on Linux (CI) and macOS.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pidRunsCommand } from "../src/pidFile.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "joshu-pid-file-"));
const children = [];

/**
 * Start a Node process whose command line contains the words of `command`, so the pattern checks
 * of the scripts and of pidRunsCommand match it. An earlier version ran `bash -c 'exec -a
 * "<command>" sleep 300'`, and on the CI runner that dummy process sometimes ended at once.
 */
async function startDummy(command) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "--", ...command.split(" ")], {
    stdio: "ignore",
  });
  child.exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  children.push(child);
  const pattern = new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  for (let i = 0; i < 50 && !(await pidRunsCommand(child.pid, pattern)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(await pidRunsCommand(child.pid, pattern), `dummy process runs "${command}"`);
  return child;
}

/** True when `child` exits in `ms` milliseconds. */
function exitsWithin(child, ms) {
  return Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
}

function runBash(script, env) {
  const result = spawnSync("bash", ["-c", script], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

try {
  // 1. scripts/stop-gbrain.sh: the sync PID file names a real `gbrain sync --watch`; the
  //    gbrain MCP HTTP PID file and the embed PID file name an unrelated process (the incident).
  const unrelated = await startDummy("hindsight-api --host 127.0.0.1 --port 8888");
  const sync = await startDummy("gbrain sync --watch");
  const appDir = path.join(tmp, "app");
  mkdirSync(appDir);
  symlinkSync(path.join(root, "scripts"), path.join(appDir, "scripts"));
  const gbrainHome = path.join(tmp, "gbrain");
  mkdirSync(gbrainHome);
  const httpPidFile = path.join(gbrainHome, "gbrain-mcp-http.pid");
  const syncPidFile = path.join(gbrainHome, "gbrain-sync.pid");
  const embedPidFile = path.join(gbrainHome, "gbrain-embed.pid");
  writeFileSync(httpPidFile, `${unrelated.pid}\n`);
  writeFileSync(embedPidFile, `${unrelated.pid}\n`);
  writeFileSync(syncPidFile, `${sync.pid}\n`);

  const stop = runBash(`bash "${path.join(root, "scripts/stop-gbrain.sh")}"`, {
    APP_DIR: appDir,
    GBRAIN_HOME: gbrainHome,
    GBRAIN_MCP_HTTP_PID_FILE: httpPidFile,
    GBRAIN_PID_FILE: syncPidFile,
    GBRAIN_EMBED_PID_FILE: embedPidFile,
    GBRAIN_BIN: "gbrain-not-installed",
  });
  assert.equal(stop.status, 0, `stop-gbrain.sh exits 0:\n${stop.output}`);
  assert.equal(await exitsWithin(sync, 3000), true, "stop-gbrain.sh stops the real sync --watch process");
  assert.equal(await exitsWithin(unrelated, 500), false, "stop-gbrain.sh does not stop the unrelated process");
  assert.match(stop.output, /does not run gbrain-mcp-http-server .*removing only the PID file/);
  for (const file of [httpPidFile, syncPidFile, embedPidFile]) {
    assert.equal(existsSync(file), false, `stop-gbrain.sh removes ${path.basename(file)}`);
  }

  // 2. stop_pid_file_process in scripts/lib/pid-file.sh, with a PID file that has no process.
  const helper = path.join(root, "scripts/lib/pid-file.sh");
  const deadPidFile = path.join(tmp, "dead.pid");
  writeFileSync(deadPidFile, "999999\n");
  const dead = runBash(`source "${helper}"; stop_pid_file_process "${deadPidFile}" "anything" "[test]"`, {});
  assert.equal(dead.status, 0, dead.output);
  assert.equal(existsSync(deadPidFile), false, "a PID file without a process is removed");

  // 3. restart_hermes_gateway_if_running in scripts/lib/hermes-gateway.sh: gateway.pid is JSON.
  const hermesHome = path.join(tmp, "hermes");
  mkdirSync(hermesHome);
  const gatewayPidFile = path.join(hermesHome, "gateway.pid");
  const gatewayLib = path.join(root, "scripts/lib/hermes-gateway.sh");
  const gatewayEnv = { HERMES_HOME: hermesHome, HERMES_API_AUTO_START: "false" };
  writeFileSync(gatewayPidFile, JSON.stringify({ pid: unrelated.pid, kind: "hermes-gateway" }));
  const skip = runBash(`source "${gatewayLib}"; restart_hermes_gateway_if_running`, gatewayEnv);
  assert.equal(skip.status, 0, skip.output);
  assert.equal(await exitsWithin(unrelated, 500), false, "the gateway restart does not stop the unrelated process");

  const gateway = await startDummy("/opt/hermes-agent/venv/bin/hermes gateway run --replace");
  writeFileSync(gatewayPidFile, JSON.stringify({ pid: gateway.pid, kind: "hermes-gateway" }));
  const restart = runBash(`source "${gatewayLib}"; sleep() { :; }; restart_hermes_gateway_if_running`, gatewayEnv);
  assert.equal(restart.status, 0, restart.output);
  assert.equal(await exitsWithin(gateway, 3000), true, "the gateway restart stops the real Hermes gateway");
  assert.equal(existsSync(gatewayPidFile), false, "the gateway restart removes gateway.pid");

  // 4. pidRunsCommand (src/pidFile.ts), which the Joshu API uses before it stops the Hermes gateway.
  assert.equal(await pidRunsCommand(unrelated.pid, /hermes.*gateway run/), false);
  assert.equal(await pidRunsCommand(unrelated.pid, /hindsight-api/), true);
  assert.equal(await pidRunsCommand(999999, /sleep/), false);

  console.log("test-pid-file-kill-check: ok");
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}
