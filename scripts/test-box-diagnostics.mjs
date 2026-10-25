#!/usr/bin/env npx tsx
/**
 * Unit tests: diagnostics command of the instance agent (change release-deploy-automation).
 * Checks the allowlist of queries and arguments, the answers with fake docker and HTTP, and the
 * read-only Python probe on a temporary Hermes home.
 *
 * Usage: npm run test:box-diagnostics
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDiagnosticsPayload, runDiagnostics } from "../packages/instance-agent/src/diagnostics.js";
import { DIAGNOSTICS_PROBE } from "../packages/instance-agent/src/diagnosticsProbe.js";

// Allowlist: unknown queries, unknown arguments, and paths outside the allowlist are errors.
assert.throws(() => parseDiagnosticsPayload({}), /non-empty array/);
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "shell", args: { cmd: "rm -rf /" } }] }), /unknown query/);
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "version", args: { cmd: "id" } }] }), /no argument cmd/);
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "logs", args: { source: "/etc/passwd" } }] }), /logs source/);
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "logs", args: { source: "caddy", since: "100h" } }] }), /72h/);
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "logs", args: { source: "hermes-agent", since: "1h" } }] }), /since is not supported/);
assert.equal(parseDiagnosticsPayload({ queries: [{ query: "logs", args: { source: "caddy", grep: "(a+)+$" } }] })[0].args.grep, "(a+)+$");
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "kanban", args: { board: "../x" } }] }), /not allowed/);
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "joshu_api", args: { path: "/joshu/api/telephone" } }] }), /path must be/);
assert.throws(() => parseDiagnosticsPayload({ queries: [{ query: "joshu_api", args: { path: "/joshu/api/cron/jobs?x=$(id)" } }] }), /not allowed/);
assert.throws(() => parseDiagnosticsPayload({ queries: Array(11).fill({ query: "version" }) }), /at most 10/);
assert.deepEqual(
  parseDiagnosticsPayload({ queries: [{ query: "logs", args: { source: "joshu-stack", since: "24h", grep: "unknown action" } }] }),
  [{ query: "logs", args: { source: "joshu-stack", since: "24h", tail: 300, grep: "unknown action" } }],
);
assert.deepEqual(
  parseDiagnosticsPayload({ queries: [{ query: "logs", args: { source: "joshu-stack", grep: "x" } }] })[0].args,
  { source: "joshu-stack", tail: 300, grep: "x", since: "24h" },
);

// Answers with fake docker, HTTP, and files.
const calls = [];
const deps = {
  composeProject: "deploy",
  joshuBaseUrl: "http://127.0.0.1:8788",
  instanceEnvFile: "/etc/joshu/instance.env",
  hostBundleFile: "/opt/joshu/deploy/.host-bundle.json",
  docker: async (args) => {
    calls.push(args);
    if (args[0] === "ps") return "deploy-joshu-stack-1\ndeploy-caddy-1\nother-1\n";
    if (args[0] === "inspect") return '{"name":"/deploy-joshu-stack-1","restartCount":0}\n{"name":"/deploy-caddy-1","restartCount":2}\n';
    if (args[0] === "logs") return "a ok\nb unknown action x\nc ok\n";
    if (args[0] === "exec") return '{"jobs":[{"name":"EA morning"}]}';
    throw new Error(`unexpected docker ${args.join(" ")}`);
  },
  fetchText: async (url) => ({ status: 200, text: JSON.stringify({ url, releaseVersion: "0.1.52" }) }),
  readText: async (path) => {
    if (path.endsWith("instance.env")) return "JOSHU_RELEASE_VERSION=0.1.52\nTWILIO_AUTH_TOKEN=secret-value\n";
    return '{"version":"0.1.52"}';
  },
};
const result = await runDiagnostics(
  {
    queries: [
      { query: "version" },
      { query: "containers" },
      { query: "logs", args: { source: "joshu-stack", grep: "unknown action" } },
      { query: "cron_jobs" },
      { query: "env_keys" },
      { query: "joshu_api", args: { path: "/joshu/api/cron/status" } },
    ],
  },
  deps,
);
const [version, containers, logs, cron, envKeys, api] = result.answers;
assert.equal(version.data.joshu.releaseVersion, "0.1.52");
assert.deepEqual(version.data.instanceEnvPins, { JOSHU_RELEASE_VERSION: "0.1.52" });
assert.equal(containers.data.containers.length, 2);
assert.deepEqual(calls.find((c) => c[0] === "inspect").slice(-2), ["deploy-joshu-stack-1", "deploy-caddy-1"]);
assert.deepEqual(logs.data.lines, ["b unknown action x"]);
assert.deepEqual(calls.find((c) => c[0] === "logs").slice(2, 4), ["--since", "24h"], "grep without since reads 24 hours");
assert.ok(!calls.find((c) => c[0] === "logs").includes("--tail"), "grep reads all lines in the window");
assert.equal(cron.data.jobs[0].name, "EA morning");
assert.equal(envKeys.data.instanceEnv.TWILIO_AUTH_TOKEN, "[set]");
assert.ok(!JSON.stringify(result).includes("secret-value"), "no secret value in the result");
assert.equal(api.data.body.url, "http://127.0.0.1:8788/joshu/api/cron/status");

// A failing query gives ok:false and does not stop the other queries.
const failing = await runDiagnostics(
  { queries: [{ query: "health" }, { query: "version" }] },
  { ...deps, fetchText: async () => { throw new Error("ECONNREFUSED"); } },
);
assert.equal(failing.answers[0].ok, false);
assert.match(failing.answers[0].error, /ECONNREFUSED/);
assert.equal(failing.answers[1].ok, true, "version answers also when the Joshu API is down");
assert.match(failing.answers[1].data.joshu.error, /ECONNREFUSED/);
assert.equal(failing.answers[1].data.instanceEnvPins.JOSHU_RELEASE_VERSION, "0.1.52");

// Long logs are cut from the oldest line.
const long = await runDiagnostics(
  { queries: [{ query: "logs", args: { source: "caddy", tail: 2000 } }] },
  { ...deps, docker: async () => Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n") },
);
assert.equal(long.answers[0].truncated, true);
assert.match(long.answers[0].data.lines.at(-1), /^line 1999 /);
assert.ok(JSON.stringify(long).length < 70_000);

// Python probe on a temporary Hermes home.
const home = mkdtempSync(join(tmpdir(), "box-diagnostics-"));
mkdirSync(join(home, "cron"));
writeFileSync(join(home, "cron/jobs.json"), JSON.stringify({ jobs: [{ id: "j1", name: "EA morning", prompt: "owner text", last_error: "boom" }] }));
writeFileSync(join(home, ".env"), "OPENROUTER_API_KEY=sk-secret\nCAMOFOX_URL=x\n");
mkdirSync(join(home, "kanban/boards/ea-mail-ingress"), { recursive: true });
execFileSync("python3", ["-c", `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE tasks (id TEXT, title TEXT, status TEXT, created_at REAL, completed_at REAL)")
db.execute("INSERT INTO tasks VALUES ('t1', 'Reply to Acme', 'blocked', 1, NULL)")
db.execute("INSERT INTO tasks VALUES ('t2', 'Done task', 'done', 2, 3)")
db.commit()
`, join(home, "kanban/boards/ea-mail-ingress/kanban.db")]);
const runProbe = (...args) =>
  JSON.parse(execFileSync("python3", ["-c", DIAGNOSTICS_PROBE, ...args], { env: { ...process.env, HERMES_HOME: home }, encoding: "utf8" }));
const probeCron = runProbe("cron_jobs");
assert.equal(probeCron.jobs[0].name, "EA morning");
assert.equal(probeCron.jobs[0].prompt, undefined, "the probe drops the prompt of a cron job");
assert.deepEqual(runProbe("env_keys").hermesEnvKeys, ["CAMOFOX_URL", "OPENROUTER_API_KEY"]);
assert.deepEqual(runProbe("kanban").boards["ea-mail-ingress"], { blocked: 1, done: 1 });
const board = runProbe("kanban", "ea-mail-ingress", "10");
assert.equal(board.tasks.length, 2);
assert.equal(board.status.blocked, 1);
assert.equal(runProbe("realtime_goals").present, false);
const skill = (dir, text) => {
  mkdirSync(join(home, "skills", dir), { recursive: true });
  writeFileSync(join(home, "skills", dir, "SKILL.md"), text);
};
skill("top", "---\nname: top\nversion: 1.10.0\nmetadata:\n  hermes:\n    version: 9.9.9\n---\n# Top\n");
skill("ea/nested", '---\nname: nested\nmetadata:\n  hermes:\n    category: ea\n    version: "4.29.0"\n---\n# Nested\n');
skill("none", "---\nname: none\n---\n# None\n\n    version: 2.0.0\n");
skill("no-front-matter", "# Plain\nversion: 3.0.0\n");
assert.deepEqual(
  runProbe("skills").skills,
  { "ea/nested": "4.29.0", "no-front-matter": null, none: null, top: "1.10.0" },
  "the probe reads a top-level or nested version from the front matter only",
);

console.log("test-box-diagnostics: ok");

