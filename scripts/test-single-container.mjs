#!/usr/bin/env npx tsx
/**
 * Unit tests for single-container mode (change single-container-mode): the links from the
 * image paths to the data root (scripts/lib/data-root.sh), the Caddyfile of the mode, and
 * the edge check of the box health (src/edgeHealth.ts).
 *
 * Usage: npm run test:single-container
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { edgeCheckPlan, probeEdge } from "../src/edgeHealth.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRootLib = path.join(repoRoot, "scripts", "lib", "data-root.sh");
const renderCaddyfile = path.join(repoRoot, "deploy", "scripts", "render-caddyfile.sh");

const LINKS = [
  ["/var/lib/arozos", "arozos"],
  ["/root/.hermes", "hermes"],
  ["/root/.gbrain", "gbrain"],
  ["/var/lib/postgresql/hindsight", "postgres-hindsight"],
  ["/home/hindsight/.hindsight", "hindsight-home"],
  ["/home/hindsight/.cache/huggingface", "hindsight-cache"],
  ["/var/lib/joshu-voice", "voice"],
  ["/root/.hindsight", "hindsight-root"],
  ["/etc/joshu", "secrets"],
];

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function linkDataRoot(prefix, dataRoot) {
  return execFileSync("bash", ["-c", `source "${dataRootLib}" && link_data_root`], {
    env: { ...process.env, JOSHU_DATA_ROOT: dataRoot, JOSHU_DATA_ROOT_PATH_PREFIX: prefix },
    encoding: "utf8",
  });
}

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "single-container-"));
  const prefix = path.join(base, "image");
  const dataRoot = path.join(base, "data");
  // What the image has at two of the paths.
  write(path.join(prefix, "var/lib/arozos/template.txt"), "from image");
  write(path.join(prefix, "root/.hermes/config.yaml"), "image config");
  // A path that the image keeps outside the list, which must stay a real folder.
  write(path.join(prefix, "root/.bun/bin/bun"), "bun");
  return { base, prefix, dataRoot };
}

// First start on an empty data root: each path is a link, and the folders hold the image content.
{
  const { prefix, dataRoot } = setup();
  linkDataRoot(prefix, dataRoot);
  for (const [imagePath, name] of LINKS) {
    const link = path.join(prefix, imagePath);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${imagePath} is a link`);
    assert.equal(fs.readlinkSync(link), path.join(dataRoot, name));
    assert.ok(fs.statSync(path.join(dataRoot, name)).isDirectory(), `${name} exists`);
  }
  assert.equal(fs.readFileSync(path.join(dataRoot, "arozos/template.txt"), "utf8"), "from image");
  assert.equal(fs.readFileSync(path.join(prefix, "var/lib/arozos/template.txt"), "utf8"), "from image");
  assert.ok(!fs.lstatSync(path.join(prefix, "root/.bun")).isSymbolicLink(), "/root/.bun stays from the image");
  assert.equal((fs.statSync(path.join(dataRoot, "secrets")).mode & 0o777).toString(8), "700");
  console.log("ok first start on an empty data root");
}

// Start after a rebuild: a new image tree, and a data root with owner files that differ from the image.
{
  const { base, prefix, dataRoot } = setup();
  write(path.join(dataRoot, "arozos/files/users/owner/Desktop/note.md"), "owner note");
  write(path.join(dataRoot, "hermes/config.yaml"), "owner config");
  write(path.join(dataRoot, "secrets/instance.env"), "CUSTOMER_DOMAIN=mybox.example.com\n");
  linkDataRoot(prefix, dataRoot);
  assert.equal(fs.readFileSync(path.join(prefix, "var/lib/arozos/files/users/owner/Desktop/note.md"), "utf8"), "owner note");
  assert.equal(fs.readFileSync(path.join(prefix, "root/.hermes/config.yaml"), "utf8"), "owner config");
  assert.ok(!fs.existsSync(path.join(dataRoot, "arozos/template.txt")), "an existing folder gets no image content");
  assert.equal(fs.readFileSync(path.join(prefix, "etc/joshu/instance.env"), "utf8"), "CUSTOMER_DOMAIN=mybox.example.com\n");
  // The real image folder is moved aside, not deleted.
  assert.equal(fs.readFileSync(path.join(prefix, "root/.hermes.image/config.yaml"), "utf8"), "image config");

  // A second start on the same tree changes nothing.
  linkDataRoot(prefix, dataRoot);
  assert.equal(fs.readFileSync(path.join(prefix, "root/.hermes/config.yaml"), "utf8"), "owner config");
  assert.ok(fs.existsSync(path.join(base, "image/root/.hermes.image/config.yaml")));
  console.log("ok start after a rebuild keeps the data root");
}

// Without JOSHU_DATA_ROOT the start script does not touch the paths.
{
  const startScript = fs.readFileSync(path.join(repoRoot, "deploy", "scripts", "vps-start.sh"), "utf8");
  assert.match(startScript, /if \[\[ -n "\$\{JOSHU_DATA_ROOT:-\}" \]\]; then[\s\S]*?link_data_root/);
  const dataRootStep = startScript.indexOf("link_data_root");
  const firstEnvLoad = startScript.indexOf('load_env_file "${HERMES_HOME}/.env"');
  assert.ok(dataRootStep > 0 && dataRootStep < firstEnvLoad, "links come before the env files load");
  assert.throws(() =>
    execFileSync("bash", ["-c", `unset JOSHU_DATA_ROOT; source "${dataRootLib}" && link_data_root`], { stdio: "pipe" }),
  );
  console.log("ok no data root, no links");
}

// The voice service and the instance agent start early: after the box-secrets file loads,
// and before the start script waits for the Joshu API.
{
  const startScript = fs.readFileSync(path.join(repoRoot, "deploy", "scripts", "vps-start.sh"), "utf8");
  const boxSecrets = startScript.indexOf("\nload_box_secrets_env\n");
  const voiceStart = startScript.indexOf("run_supervised voice-realtime single_container_voice");
  const agentStart = startScript.indexOf("run_supervised instance-agent single_container_agent");
  const apiWait = startScript.indexOf('curl -fsS "${JOSHU_HEALTH_URL}"');
  assert.ok(boxSecrets > 0 && voiceStart > boxSecrets && agentStart > voiceStart, "voice and agent start after box-secrets");
  assert.ok(apiWait > 0 && agentStart < apiWait, "voice and agent do not wait for the Joshu API");
  assert.equal(startScript.split("run_supervised voice-realtime").length, 2, "one start of the voice service");
  assert.equal(startScript.split("run_supervised instance-agent").length, 2, "one start of the instance agent");
  console.log("ok voice service and instance agent start early");
}

// Log files: in single-container mode the output of the stack and of each supervised process
// also goes to "<data root>/logs/<name>.log" with a timestamp on each line.
{
  const startScript = fs.readFileSync(path.join(repoRoot, "deploy", "scripts", "vps-start.sh"), "utf8");
  const guard = startScript.indexOf('JOSHU_LOG_DIR="${JOSHU_DATA_ROOT}/logs"');
  const redirect = startScript.indexOf("exec > >(stamp_log joshu-stack 3) 2>&1");
  const firstEnvLoad = startScript.indexOf('load_env_file "${HERMES_HOME}/.env"');
  assert.ok(guard > 0 && redirect > guard && redirect < firstEnvLoad, "the log redirect comes before the env files load");
  assert.match(startScript, /if \[\[ "\$\{JOSHU_SINGLE_CONTAINER\}" == "1" \]\]; then\n  JOSHU_LOG_DIR=/, "only single-container mode writes log files");
  assert.match(startScript, /\{ "\$@" 2>&1 \|\| true; \} \| stamp_log "\$\{name\}" 3/, "each supervised process has its own log file");
  assert.match(startScript, /rotate_log "\$\{JOSHU_LOG_DIR\}\/\$\{name\}\.log"\n\s+\{ "\$@"/, "the size check runs before each start of a supervised process");
  assert.match(startScript, /mv -f "\$\{file\}" "\$\{file\}\.1" 2>\/dev\/null \|\| true/, "a failed move does not stop the box");

  // The two functions work on a temporary folder. `printf %(...)T` needs bash 4.2 or later.
  const bashMajor = Number(execFileSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}"], { encoding: "utf8" }).trim());
  if (bashMajor >= 42) {
    const functions = startScript.slice(startScript.indexOf("rotate_log() {"), startScript.indexOf('if [[ "${JOSHU_SINGLE_CONTAINER}" == "1" ]]; then\n  JOSHU_LOG_DIR='));
    const dir = mkdtempSync(path.join(tmpdir(), "single-container-logs-"));
    const out = execFileSync(
      "bash",
      ["-c", `set -euo pipefail\nJOSHU_LOG_DIR="${dir}"; JOSHU_LOG_MAX_BYTES=40\n${functions}\nprintf 'first line\\nsecond line\\nno newline at the end' | stamp_log voice-realtime 1\nrotate_log "${dir}/voice-realtime.log"\necho after | stamp_log voice-realtime 1`],
      { encoding: "utf8" },
    );
    assert.equal(out, "first line\nsecond line\nno newline at the end\nafter\n", "the output of the container is unchanged");
    const rotated = fs.readFileSync(path.join(dir, "voice-realtime.log.1"), "utf8").split("\n");
    assert.match(rotated[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ first line$/);
    assert.match(rotated[2], /Z no newline at the end$/);
    assert.match(fs.readFileSync(path.join(dir, "voice-realtime.log"), "utf8"), /^\S+Z after\n$/, "a file over the limit moves to .log.1");
    // A log folder that cannot be written: the output of the container still passes, and nothing fails.
    const noFolder = execFileSync(
      "bash",
      ["-c", `set -euo pipefail\nJOSHU_LOG_DIR="${dir}/missing/folder"; JOSHU_LOG_MAX_BYTES=40\n${functions}\nprintf 'one\\ntwo\\n' | stamp_log caddy 1\nrotate_log "${dir}/missing/folder/caddy.log"\necho done`],
      { encoding: "utf8" },
    );
    assert.equal(noFolder, "one\ntwo\ndone\n", "a failed write to a log file does not stop the box");
    console.log("ok log files with timestamps and rotation");
  } else {
    console.log("ok log files (static checks only: this bash is older than 4.2)");
  }
}

// The Caddyfile of single-container mode: plain HTTP on 8080 with the routes of the domain site.
{
  const out = path.join(mkdtempSync(path.join(tmpdir(), "single-container-caddy-")), "Caddyfile");
  const render = (env) => {
    execFileSync("sh", [renderCaddyfile, "/nonexistent/instance.env"], {
      env: { PATH: process.env.PATH, CADDYFILE_OUT: out, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return fs.readFileSync(out, "utf8");
  };
  const single = render({ JOSHU_DATA_ROOT: "/data", CUSTOMER_DOMAIN: "mybox.example.com" });
  assert.match(single, /^:8080 \{/m);
  assert.doesNotMatch(single, /mybox\.example\.com/);
  assert.match(single, /reverse_proxy \/joshu\/\* 127\.0\.0\.1:8788/);
  assert.match(single, /reverse_proxy \/voice-rt\/\* 127\.0\.0\.1:8792/);
  assert.match(single, /reverse_proxy 127\.0\.0\.1:8787/);

  const compose = render({ CUSTOMER_DOMAIN: "mybox.example.com" });
  assert.match(compose, /^mybox\.example\.com \{/m);
  assert.doesNotMatch(compose, /:8080/);
  console.log("ok Caddyfile in both modes");
}

// Edge check of the box health: port 443 on a Compose host, port 8080 and the tunnel in single-container mode.
{
  const reader = (vars) => (name) => vars[name] ?? "";
  const probes = (open, tunnelReady) => {
    const calls = [];
    return {
      calls,
      tcp: async (port) => (calls.push(`tcp ${port}`), open.includes(port)),
      http200: async (url) => (calls.push(`get ${url}`), tunnelReady),
    };
  };

  const compose = edgeCheckPlan(reader({ CUSTOMER_DOMAIN: "mybox.example.com" }));
  assert.deepEqual(compose, { expected: true, tcpPort: 443, tunnelReadyUrl: null });
  assert.deepEqual(edgeCheckPlan(reader({})), { expected: false, tcpPort: 443, tunnelReadyUrl: null });
  assert.equal(await probeEdge(edgeCheckPlan(reader({})), probes([], false)), true);
  assert.equal(await probeEdge(compose, probes([443], false)), true);
  assert.equal(await probeEdge(compose, probes([8080], true)), false);

  const single = edgeCheckPlan(
    reader({ JOSHU_DATA_ROOT: "/data", CUSTOMER_DOMAIN: "mybox.example.com", CLOUDFLARE_TUNNEL_TOKEN: "t" }),
  );
  assert.deepEqual(single, { expected: true, tcpPort: 8080, tunnelReadyUrl: "http://127.0.0.1:20241/ready" });
  const healthy = probes([8080], true);
  assert.equal(await probeEdge(single, healthy), true);
  assert.ok(!healthy.calls.includes("tcp 443"), "no port 443 in single-container mode");
  assert.equal(await probeEdge(single, probes([8080], false)), false, "tunnel down");
  assert.equal(await probeEdge(single, probes([], true)), false, "Caddy down");

  const noTunnel = edgeCheckPlan(reader({ JOSHU_DATA_ROOT: "/data" }));
  assert.deepEqual(noTunnel, { expected: true, tcpPort: 8080, tunnelReadyUrl: null });
  console.log("ok edge check in both modes");
}

console.log("single-container tests passed");
