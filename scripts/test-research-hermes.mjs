/**
 * Tests of the Hermes side of Research reports (change research-reports, task 6.1): the config
 * sync enables the plugin joshu-research and drops joshu-last30days, and the Python plugin calls
 * the Joshu API (a local stub here) and returns its answer. Also the tools of recurring reports and
 * report updates (change recurring-research-reports, task 6.1). The argument `hints` reaches the
 * Joshu API and the plan (change content-router, task 3.4). Needs python3; no Hermes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planResearch } from "../src/research/pipeline/plan.ts";
import { registerResearchRoutes } from "../src/research/routes.ts";
import {
  RETIRED_LAST30DAYS_PLUGIN,
  syncInteractivePlatformKanbanToolsets,
  syncResearchPlugin,
} from "../src/hermesApi.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function testConfigSync() {
  const config = {
    plugins: { enabled: ["joshu-desktop", RETIRED_LAST30DAYS_PLUGIN] },
    platform_toolsets: { api_server: ["hermes-api-server", "kanban", RETIRED_LAST30DAYS_PLUGIN] },
  };
  const toolsets = ["kanban", RETIRED_LAST30DAYS_PLUGIN];
  const first = syncResearchPlugin(config, toolsets);
  assert.deepEqual(first, { changed: true, pluginsChanged: true });
  assert.deepEqual(config.plugins.enabled, ["joshu-desktop", "joshu-research"]);
  assert.deepEqual(toolsets, ["kanban", "joshu-research"]);
  assert.deepEqual(syncResearchPlugin(config, toolsets), { changed: false, pluginsChanged: false }, "second sync changes nothing");

  assert.equal(syncInteractivePlatformKanbanToolsets(config), true);
  assert.ok(config.platform_toolsets.api_server.includes("joshu-research"));
  assert.ok(!config.platform_toolsets.api_server.includes(RETIRED_LAST30DAYS_PLUGIN));
  assert.equal(syncInteractivePlatformKanbanToolsets(config), false);
  console.log("ok Hermes config: joshu-research enabled, joshu-last30days removed");
}

function runPython(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", code], { cwd: path.join(repoRoot, ".hermes", "plugins"), env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `python exited ${code}`))));
  });
}

async function testPlugin() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.url.includes("/recurring") || req.url.includes("/updates")) {
        res.end(JSON.stringify({ ok: true, echo: { method: req.method, url: req.url } }));
      } else if (req.url.startsWith("/joshu/api/research/reports?")) {
        res.end(JSON.stringify({ ok: true, reports: [{ id: "2026-11-02-heat-pumps" }] }));
      } else if (JSON.parse(body || "{}").topic === "fail") {
        res.end(JSON.stringify({ ok: false, step: "collect", error: "boom" }));
      } else {
        res.end(JSON.stringify({ ok: true, report: { id: "2026-11-02-heat-pumps", reportLink: "https://x/r.pdf" } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/joshu`;
  try {
    const out = await runPython(
      `
import importlib, json
plugin = importlib.import_module("joshu-research")
tools = {}
class Ctx:
    def register_tool(self, name, toolset, schema, handler, emoji):
        assert toolset == "joshu-research" and schema["name"] == name
        tools[name] = handler
plugin.register(Ctx())
print(json.dumps(sorted(tools)))
print(tools["research_report_make"]({"topic": "Heat pumps"}))
print(tools["research_report_make"]({"topic": "fail"}))
print(tools["research_report_make"]({}))
print(tools["research_report_find"]({"query": "heat pumps"}))
print(tools["research_recurring_save"]({"topics": ["humanoid robots"], "days": ["mon"], "times": ["07:00"], "sources": "auto", "channel": "sms", "notes": "at most 8 items", "nothing_new_line": True}))
print(tools["research_recurring_save"]({"id": "rr_0000aaaa", "days": ["monday"]}))
print(tools["research_recurring_list"]({}))
print(tools["research_recurring_state"]({"id": "rr_0000aaaa", "action": "pause"}))
print(tools["research_recurring_state"]({"id": "rr_0000aaaa", "action": "delete"}))
print(tools["research_recurring_state"]({"id": "rr_0000aaaa", "action": "explode"}))
print(tools["research_update_make"]({"report_id": "2026-10-21-clara-analytics", "channel": "sms"}))
print(tools["research_update_pdf"]({"update": "Recurring/robots/updates/2026-10-31-0700"}))
print(tools["research_report_make"]({"topic": "CLARA Analytics", "notes": " not Hippo ", "sections": ["funding", " ", "competitors"]}))
print(tools["research_report_make"]({"topic": "2028 primaries", "hints": ["Polymarket for prediction market odds", " "]}))
print(tools["research_recurring_save"]({"topics": ["2028 primaries"], "days": ["mon"], "times": ["07:00"], "hints": ["Polymarket for prediction market odds"]}))
print(tools["research_report_make"]({"topic": "Heat pumps", "web_provider": "You.com"}))
`,
      { JOSHU_API_BASE_URL: base },
    );
    const [names, made, failed, empty, found, created, changed, listed, paused, deleted, bad, update, pdf, withRequest, withHints, recurringHints, withProvider] = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(names, ["research_recurring_list", "research_recurring_save", "research_recurring_state", "research_report_find", "research_report_make", "research_update_make", "research_update_pdf"]);
    assert.deepEqual(created.echo, { method: "POST", url: "/joshu/api/research/recurring" });
    const createBody = JSON.parse(seen.find((s) => s.url === "/joshu/api/research/recurring").body);
    assert.deepEqual(createBody, { topics: ["humanoid robots"], days: ["mon"], times: ["07:00"], sources: "auto", channel: "sms", notes: "at most 8 items", nothingNewLine: true });
    assert.deepEqual(changed.echo, { method: "PATCH", url: "/joshu/api/research/recurring/rr_0000aaaa" });
    assert.deepEqual(listed.echo, { method: "GET", url: "/joshu/api/research/recurring" });
    assert.deepEqual(paused.echo, { method: "POST", url: "/joshu/api/research/recurring/rr_0000aaaa/pause" });
    assert.deepEqual(deleted.echo, { method: "DELETE", url: "/joshu/api/research/recurring/rr_0000aaaa" });
    assert.equal(bad.ok, false);
    assert.deepEqual(update.echo, { method: "POST", url: "/joshu/api/research/reports/2026-10-21-clara-analytics/updates" });
    assert.deepEqual(pdf.echo, { method: "POST", url: "/joshu/api/research/updates/pdf" });
    assert.equal(made.ok, true);
    assert.equal(made.report.reportLink, "https://x/r.pdf");
    assert.deepEqual([failed.ok, failed.step], [false, "collect"]);
    assert.equal(empty.ok, false);
    assert.equal(found.reports[0].id, "2026-11-02-heat-pumps");
    assert.deepEqual(seen[0], { method: "POST", url: "/joshu/api/research/reports", body: '{"topic": "Heat pumps"}' });
    assert.equal(seen.find((s) => s.url.startsWith("/joshu/api/research/reports?")).url, "/joshu/api/research/reports?q=heat%20pumps");
    assert.equal(withRequest.ok, true);
    assert.deepEqual(JSON.parse(seen.at(-4).body), { topic: "CLARA Analytics", notes: "not Hippo", sections: ["funding", "competitors"] }, "notes and sections reach the Joshu API");
    assert.equal(withHints.ok, true);
    assert.deepEqual(JSON.parse(seen.at(-3).body), { topic: "2028 primaries", hints: ["Polymarket for prediction market odds"] }, "hints reach the Joshu API");
    assert.equal(recurringHints.ok, true);
    assert.deepEqual(JSON.parse(seen.at(-2).body).hints, ["Polymarket for prediction market odds"], "hints of research_recurring_save reach the Joshu API");
    assert.equal(withProvider.ok, true);
    assert.deepEqual(JSON.parse(seen.at(-1).body), { topic: "Heat pumps", web_provider: "you.com" }, "web_provider reaches the Joshu API (change research-web-provider)");
    assert.equal(JSON.parse(seen[0].body).web_provider, undefined, "no web_provider without the argument");
    console.log("ok plugin joshu-research: registers seven tools and calls the Joshu API");
  } finally {
    server.close();
  }
}

/** The route passes the hints to the report, and the plan model call gets them (change content-router, task 3.4). */
async function testHintsReachPlan() {
  const handlers = {};
  const made = [];
  registerResearchRoutes(
    { post: (p, h) => (handlers[`POST ${p}`] = h), get: (p, h) => (handlers[`GET ${p}`] = h) },
    { projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "research-hints-")), allowRequest: () => true, make: async (topic, opts) => (made.push({ topic, opts }), { id: "r1", topic, requestedAt: "t", summary: "s", sources: [], pdfDesktopPath: "", pdfFilesPath: "", pdfPath: "" }), publicBase: "https://x" },
  );
  const res = { json(v) { this.body = v; return this; }, status() { return this; } };
  await handlers["POST /api/research/reports"]({ body: { topic: "2028 primaries", hints: ["Polymarket for prediction market odds", 7] } }, res);
  assert.deepEqual(made[0].opts.request, { hints: ["Polymarket for prediction market odds"] });
  // The web search provider (change research-web-provider): Exa by default, You.com when named, 400 for others.
  assert.equal(made[0].opts.webProvider, "exa");
  await handlers["POST /api/research/reports"]({ body: { topic: "Heat pumps", web_provider: "you.com" } }, res);
  assert.equal(made[1].opts.webProvider, "you.com");
  const bad = { json(v) { this.body = v; return this; }, status(c) { this.code = c; return this; } };
  await handlers["POST /api/research/reports"]({ body: { topic: "Heat pumps", web_provider: "bing" } }, bad);
  assert.equal(bad.code, 400);
  assert.equal(made.length, 2, "an unknown provider makes no report");

  const prompts = [];
  const fetchImpl = async (_u, init) => {
    prompts.push(JSON.parse(init.body).messages[1].content);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
  };
  await planResearch("2028 primaries", "2026-11-01", Date.now() + 5000, { fetchImpl, apiKey: "k", model: "m" }, made[0].opts.request);
  assert.match(prompts[0], /Hints:\n- Polymarket for prediction market odds/);
  console.log("ok hints reach the plan of a Research report");
}

testConfigSync();
await testPlugin();
await testHintsReachPlan();
console.log("all research Hermes checks passed");
