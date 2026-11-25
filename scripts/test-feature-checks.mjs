#!/usr/bin/env npx tsx
/**
 * Unit tests: feature checks of component `capabilities` in the health report
 * (change box-capability-checks).
 *
 * Usage: npm run test:feature-checks
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

import {
  FeatureCheckRunner,
  boxFeatureChecks,
  summarizeChecks,
} from "../src/featureChecks.js";
import { registerInstanceHealthRoutes } from "../src/instanceHealth.js";

const dir = await mkdtemp(path.join(tmpdir(), "joshu-feature-checks-"));
const configPath = path.join(dir, "config.yaml");

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake fetch that answers by URL and records each call. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    for (const [match, answer] of routes) {
      if (String(url).includes(match)) return typeof answer === "function" ? answer(url, init) : answer();
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { impl, calls };
}

function makeDeps(overrides = {}) {
  return {
    fetch: overrides.fetch,
    hermesConfigPath: configPath,
    exaKey: () => overrides.exaKey ?? "exa-test-key",
    you: () => (overrides.you === undefined ? null : overrides.you),
    hindsight: {
      enabled: () => overrides.hindsightEnabled ?? true,
      apiUrl: "http://hindsight.test:8888/",
      bankId: "joshu",
      headers: () => ({}),
    },
    socialSourcesHealth: () => ({
      ok: true,
      router: overrides.router ?? { mode: "relay", configured: true, kind: "agent token" },
      sources: [],
    }),
  };
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

function okRoutes(operations = []) {
  return [
    ["api.exa.ai/search", () => json(200, { results: [{ url: "https://example.com", title: "x" }] })],
    ["/memories/recall", () => json(200, { results: [{ text: "OWNER SECRET MEMORY" }] })],
    ["/operations", () => json(200, { bank_id: "joshu", total: operations.length, limit: 100, offset: 0, operations })],
  ];
}

async function runOnce(deps) {
  const runner = new FeatureCheckRunner(boxFeatureChecks(deps));
  await runner.runLive();
  return runner.report();
}

try {
  await writeFile(configPath, "web:\n  backend: exa\n");

  // Pending before the first live run, and a health read makes no call.
  {
    const fetch = fakeFetch(okRoutes());
    const runner = new FeatureCheckRunner(boxFeatureChecks(makeDeps({ fetch: fetch.impl })));
    for (let i = 0; i < 60; i += 1) runner.report();
    const report = runner.report();
    assert.equal(fetch.calls.length, 0, "a health read never calls a service");
    assert.equal(report.ok, true);
    for (const name of ["web_search", "hindsight_recall", "hindsight_saves"]) {
      assert.equal(report.checks[name].pending, true, `${name} pending`);
      assert.equal(report.checks[name].checkedAt, null);
    }
    assert.equal(report.checks.content_router.ok, true);
    assert.ok(report.checks.content_router.checkedAt, "config check has a time");

    // One live run makes one call per live feature check; later reads make none.
    await runner.runLive();
    for (let i = 0; i < 60; i += 1) runner.report();
    assert.equal(fetch.calls.filter((c) => c.url.includes("api.exa.ai")).length, 1);
    assert.equal(fetch.calls.filter((c) => c.url.includes("/memories/recall")).length, 1);
    const after = runner.report();
    assert.equal(after.ok, true);
    assert.equal(after.reason, undefined);
    assert.equal(after.checks.web_search.pending, undefined);
    assert.ok(after.checks.web_search.checkedAt);
    assert.ok(!JSON.stringify(after).includes("OWNER SECRET MEMORY"), "recall text never reaches the report");
    const recall = fetch.calls.find((c) => c.url.includes("/memories/recall"));
    assert.equal(recall.url, "http://hindsight.test:8888/v1/default/banks/joshu/memories/recall");
    assert.equal(JSON.parse(recall.body).query, "Joshu feature check");
  }

  // web_search: Exa key missing fails from config, with no call.
  {
    const fetch = fakeFetch(okRoutes());
    const report = await runOnce(makeDeps({ fetch: fetch.impl, exaKey: "" }));
    assert.equal(report.checks.web_search.ok, false);
    assert.equal(report.checks.web_search.reason, "EXA_API_KEY is not set");
    assert.equal(fetch.calls.filter((c) => c.url.includes("api.exa.ai")).length, 0);
    assert.equal(report.ok, false);
    assert.match(report.reason, /^web_search: EXA_API_KEY is not set$/);
  }

  // web_search: no backend in the Hermes config means Exa.
  {
    await writeFile(configPath, "model: x\n");
    const report = await runOnce(makeDeps({ fetch: fakeFetch(okRoutes()).impl, exaKey: "" }));
    assert.equal(report.checks.web_search.reason, "EXA_API_KEY is not set");
    await rm(configPath);
    const noFile = await runOnce(makeDeps({ fetch: fakeFetch(okRoutes()).impl }));
    assert.equal(noFile.checks.web_search.ok, true, "missing config file with a key: Exa answers");
    await writeFile(configPath, "web:\n  backend: exa\n");
  }

  // web_search with backend `you` (change you-web-provider): the box must be able to reach
  // You.com, and one You.com search must pass. Exa does not answer for You.com in this check.
  {
    await writeFile(configPath, "web:\n  backend: you\n");
    const noAccess = await runOnce(makeDeps({ fetch: fakeFetch(okRoutes()).impl, you: null }));
    assert.equal(noAccess.checks.web_search.ok, false);
    assert.equal(noAccess.checks.web_search.reason, "the box cannot reach You.com: no relay mode and no You.com key");
    const posts = [];
    const good = await runOnce(makeDeps({ fetch: fakeFetch(okRoutes()).impl, you: { post: async (path, body) => (posts.push([path, body.query, body.count]), { results: { web: [{ url: "https://example.com" }] } }) } }));
    assert.equal(good.checks.web_search.ok, true);
    assert.deepEqual(posts, [["/v1/search", "Joshu feature check", 1]]);
    const exaFetch = fakeFetch(okRoutes());
    const down = await runOnce(makeDeps({ fetch: exaFetch.impl, you: { post: async () => { throw new Error("You.com /v1/search answered 503"); } } }));
    assert.equal(down.checks.web_search.ok, false);
    assert.match(down.checks.web_search.reason, /^You\.com search failed: .*503/);
    assert.equal(exaFetch.calls.filter((c) => c.url.includes("api.exa.ai")).length, 0, "Exa does not hide a You.com fault");
    await writeFile(configPath, "web:\n  backend: exa\n");
  }

  // web_search: unknown backend fails, so a new backend is not silently green.
  {
    await writeFile(configPath, "web:\n  backend: tavily\n");
    const report = await runOnce(makeDeps({ fetch: fakeFetch(okRoutes()).impl }));
    assert.equal(report.checks.web_search.ok, false);
    assert.equal(report.checks.web_search.reason, "web search backend tavily has no feature check");
    await writeFile(configPath, "web:\n  backend: exa\n");
  }

  // web_search: Exa rejects the key.
  {
    const routes = okRoutes();
    routes[0] = ["api.exa.ai/search", () => json(401, { error: "invalid key" })];
    const report = await runOnce(makeDeps({ fetch: fakeFetch(routes).impl }));
    assert.equal(report.checks.web_search.ok, false);
    assert.match(report.checks.web_search.reason, /401/);
    assert.ok(!report.checks.web_search.reason.includes("exa-test-key"), "no key value in the reason");
  }

  // hindsight_recall: status 500 from a broken reranker, and a timeout.
  {
    const routes = okRoutes();
    routes[1] = ["/memories/recall", () => new Response("PermissionError: google-reranker-service-account.json", { status: 500 })];
    const report = await runOnce(makeDeps({ fetch: fakeFetch(routes).impl }));
    assert.equal(report.checks.hindsight_recall.ok, false);
    assert.match(report.checks.hindsight_recall.reason, /status 500/);

    const slow = okRoutes();
    slow[1] = [
      "/memories/recall",
      () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      },
    ];
    const timedOut = await runOnce(makeDeps({ fetch: fakeFetch(slow).impl }));
    assert.equal(timedOut.checks.hindsight_recall.ok, false);
    assert.equal(timedOut.checks.hindsight_recall.reason, "no answer in 20 seconds");
  }

  // Hindsight turned off: recall fails, saves notes it, and neither calls Hindsight.
  {
    const fetch = fakeFetch(okRoutes());
    const report = await runOnce(makeDeps({ fetch: fetch.impl, hindsightEnabled: false }));
    assert.equal(report.checks.hindsight_recall.ok, false);
    assert.equal(report.checks.hindsight_recall.reason, "Hindsight is turned off");
    assert.equal(report.checks.hindsight_saves.ok, true);
    assert.equal(report.checks.hindsight_saves.note, "Hindsight is turned off");
    assert.equal(fetch.calls.filter((c) => c.url.includes("hindsight.test")).length, 0);
  }

  // hindsight_saves: every save failed (clara, 2026-10).
  {
    const error = `401 Unauthorized from the LLM provider ${"x".repeat(400)}`;
    const ops = Array.from({ length: 12 }, (_, i) => ({ status: "failed", created_at: iso((i + 1) * HOUR), error_message: error }));
    const report = await runOnce(makeDeps({ fetch: fakeFetch(okRoutes(ops)).impl }));
    const saves = report.checks.hindsight_saves;
    assert.equal(saves.ok, false);
    assert.equal(saves.failed24h, 12);
    assert.match(saves.reason, /401 Unauthorized/);
    assert.ok(saves.reason.length <= 260, "error text is cut");
  }

  // hindsight_saves: a failed save followed by a successful one passes.
  {
    const ops = [
      { status: "processing", created_at: iso(0.1 * HOUR), error_message: null },
      { status: "completed", created_at: iso(1 * HOUR), error_message: null },
      { status: "failed", created_at: iso(5 * HOUR), error_message: "rate limit" },
      { status: "failed", created_at: iso(30 * HOUR), error_message: "old" },
    ];
    const report = await runOnce(makeDeps({ fetch: fakeFetch(okRoutes(ops)).impl }));
    assert.equal(report.checks.hindsight_saves.ok, true);
    assert.equal(report.checks.hindsight_saves.failed24h, 1);
  }

  // hindsight_saves: no saves in 24 hours, and the request shape.
  {
    const fetch = fakeFetch(okRoutes([{ status: "failed", created_at: iso(48 * HOUR), error_message: "old" }]));
    const report = await runOnce(makeDeps({ fetch: fetch.impl }));
    assert.equal(report.checks.hindsight_saves.ok, true);
    assert.equal(report.checks.hindsight_saves.failed24h, 0);
    const list = fetch.calls.find((c) => c.url.includes("/operations"));
    assert.match(list.url, /\/v1\/default\/banks\/joshu\/operations\?type=retain&exclude_parents=true&limit=100&offset=0$/);
  }

  // content_router: on without a key fails; on with a key and off pass.
  {
    const fetch = fakeFetch(okRoutes());
    const missing = await runOnce(makeDeps({ fetch: fetch.impl, router: { mode: "relay", configured: false, reason: "no agent token" } }));
    assert.equal(missing.checks.content_router.ok, false);
    assert.match(missing.checks.content_router.reason, /router API key is not set/);
    const off = await runOnce(makeDeps({ fetch: fetch.impl, router: { mode: "off", configured: false } }));
    assert.equal(off.checks.content_router.ok, true);
    assert.equal(fetch.calls.filter((c) => c.url.includes("router")).length, 0, "content_router makes no call");
  }

  // Summary reason names each failed feature check and stays at 300 characters or fewer.
  {
    const at = new Date().toISOString();
    const two = summarizeChecks({
      web_search: { ok: false, reason: "EXA_API_KEY is not set", checkedAt: at },
      hindsight_recall: { ok: true, checkedAt: at },
      hindsight_saves: { ok: false, reason: "latest save failed (12 failed in 24 hours): 401", checkedAt: at },
    });
    assert.equal(two.ok, false);
    assert.equal(two.reason, "web_search: EXA_API_KEY is not set; hindsight_saves: latest save failed (12 failed in 24 hours): 401");
    const long = summarizeChecks({
      a: { ok: false, reason: "y".repeat(250), checkedAt: at },
      b: { ok: false, reason: "z".repeat(250), checkedAt: at },
    });
    assert.ok(long.reason.length <= 300);
  }

  // The health route: a failed feature check changes neither `healthy`, `readyForUpdate`,
  // nor the HTTP status, and the component is in the health report.
  {
    const healthOf = async (capabilities) => {
      const app = express();
      const router = express.Router();
      registerInstanceHealthRoutes(router, {
        probeHermes: async () => ({ available: true }),
        probeCamofox: async () => ({ reachable: true }),
        probeHindsight: async () => ({ ok: true }),
        probeGbrain: async () => ({ ok: true }),
        probeConnectorsMcp: async () => ({ ok: true }),
        probeTwilio: async () => ({ ok: true }),
        connectorsMcpRequired: false,
        capabilities: () => capabilities,
      });
      app.use(router);
      const server = app.listen(0);
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}/api/instance/health`);
        return { status: res.status, body: await res.json() };
      } finally {
        server.close();
      }
    };
    const at = new Date().toISOString();
    const good = await healthOf({ ok: true, checks: { web_search: { ok: true, checkedAt: at } } });
    const bad = await healthOf(summarizeChecks({ web_search: { ok: false, reason: "EXA_API_KEY is not set", checkedAt: at } }));
    assert.equal(bad.body.components.capabilities.ok, false);
    assert.equal(bad.body.components.capabilities.reason, "web_search: EXA_API_KEY is not set");
    assert.equal(bad.status, good.status);
    assert.equal(bad.body.healthy, good.body.healthy);
    assert.equal(bad.body.readyForUpdate, good.body.readyForUpdate);
  }

  console.log("feature checks: all tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
