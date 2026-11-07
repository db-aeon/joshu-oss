/**
 * Unit tests of the content goals client (change content-router, tasks 2.1 to 2.4 and 5.2): the
 * client of the router call route and its authentication, the box skill `joshu-content-cache` and
 * its seed, the recipe reader, learning a route and a recipe, dropping a route, the check of the
 * recipe output, the default social goals of skill `joshu-content-router`, and the media route.
 * No network: fake fetch, fake router, fake model.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeRouter, learnModel, POLY_ENDPOINT, polymarketReply, POLY_RECIPE, tempHermesHome } from "./lib/content-router-fakes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-router-state-"));
// No provision file and a temporary state dir, so each setting comes from process.env.
process.env.JOSHU_COMPOSE_ENV_FILE = path.join(stateDir, "no-instance.env");
process.env.JOSHU_STATE_DIR = stateDir;

const { resolveRouterAuth, routerClient, RouterError, USAGE_WALLET_EMPTY } = await import("../src/contentRouter/client.ts");
const { writeMeteredProviderConfig } = await import("../src/meteredProviders/config.ts");
const store = await import("../src/contentRouter/store.ts");
const { applyRecipe, checkItems, checkRecipe, readPath } = await import("../src/contentRouter/recipe.ts");
const { resolveGoal, parseDefaultGoals, defaultSocialGoals, goalOfSource, COULD_NOT_BE_READ, BUILT_IN_SOCIAL_GOALS } = await import("../src/contentRouter/goals.ts");
const { makeMedia, parseMediaRequest, registerRouterMediaRoutes } = await import("../src/contentRouter/media.ts");
const learn = await import("../src/contentRouter/learn.ts");
const goals = await import("../src/contentRouter/goals.ts");
const { parseSources } = await import("../src/research/recurring/service.ts");

const ENV = ["JOSHU_ROUTER_MODE", "JOSHU_ROUTER_RELAY_URL", "JOSHU_ROUTER_API_KEY", "JOSHU_ROUTER_URL", "CONTROL_PLANE_URL", "JOSHU_INSTANCE_ID", "INSTANCE_AGENT_TOKEN"];
function resetEnv() {
  for (const name of ENV) delete process.env[name];
  fs.rmSync(path.join(stateDir, "connectors-providers.env"), { force: true });
}

/** A fake fetch that records each request and answers with `answer(url, init)`. */
function recordingFetch(answer) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const { status = 200, body = {} } = answer(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { requests, fetchImpl };
}

async function testClientAuth() {
  // Fleet box: the agent token, and the control plane of the box.
  resetEnv();
  Object.assign(process.env, {
    JOSHU_ROUTER_MODE: "relay",
    JOSHU_ROUTER_RELAY_URL: "https://cp.example/api/instances/providers/router/mcp",
    CONTROL_PLANE_URL: "https://cp.example",
    JOSHU_INSTANCE_ID: "inst-1",
    INSTANCE_AGENT_TOKEN: "tok",
    JOSHU_ROUTER_API_KEY: "jr_must_not_leak",
  });
  const fleet = resolveRouterAuth(stateDir);
  assert.deepEqual(fleet.auth, { kind: "agent token", bearer: "inst-1.tok", baseUrl: "https://cp.example" });
  const ok = recordingFetch(() => ({ body: { call_id: "rc_1", endpoint: "e1", capability: "c", channel: "treg", cost_usd: 0.002, body: { posts: [] } } }));
  const reply = await routerClient(fleet.auth, ok.fetchImpl).call({ endpoint: "e1", params: { query: "a" } }, Date.now() + 5000);
  assert.equal(ok.requests[0].url, "https://cp.example/api/router/call");
  assert.equal(ok.requests[0].init.headers.Authorization, "Bearer inst-1.tok");
  assert.deepEqual(JSON.parse(ok.requests[0].init.body), { endpoint: "e1", params: { query: "a" } });
  assert.deepEqual(reply.body, { posts: [] });

  // Self-hosted box: the router API key that the owner saved in Connectors.
  resetEnv();
  process.env.JOSHU_ROUTER_MODE = "direct";
  assert.deepEqual(resolveRouterAuth(stateDir), { auth: null, reason: "no router API key" });
  writeMeteredProviderConfig({ JOSHU_ROUTER_API_KEY: "jr_owner" }, stateDir);
  const own = resolveRouterAuth(stateDir);
  assert.deepEqual(own.auth, { kind: "router API key", bearer: "jr_owner", baseUrl: "https://hello.joshu.me" });
  const direct = recordingFetch(() => ({ body: { query: "x", capabilities: [] } }));
  await routerClient(own.auth, direct.fetchImpl).search("x posts", 20, Date.now() + 5000);
  assert.equal(direct.requests[0].url, "https://hello.joshu.me/api/router/catalog/search?q=x+posts&limit=20");
  assert.equal(direct.requests[0].init.headers.Authorization, "Bearer jr_owner");

  // Off.
  resetEnv();
  process.env.JOSHU_ROUTER_MODE = "off";
  assert.deepEqual(resolveRouterAuth(stateDir), { auth: null, reason: "content router off" });
  console.log("ok client: agent token on a fleet box, router API key on a self-hosted box");
}

async function testClientFailures() {
  const auth = { kind: "router API key", bearer: "jr_k", baseUrl: "https://hello.example" };
  const cases = [
    [402, { error: "insufficient_balance", balance_usd: 0, required_usd: 0.0021 }, USAGE_WALLET_EMPTY],
    [429, { error: "rate_limited", retry_after_seconds: 12 }, "rate limited"],
    [404, { error: "unknown_endpoint" }, "unknown endpoint"],
    [502, { error: "provider_error", status: 404, body: {} }, "provider error"],
    [503, { error: "no_channel_available" }, "no channel available"],
    [401, { error: "unauthorized" }, "unauthorized"],
  ];
  for (const [status, body, kind] of cases) {
    const { requests, fetchImpl } = recordingFetch(() => ({ status, body }));
    await assert.rejects(
      routerClient(auth, fetchImpl).call({ endpoint: "e1", params: {} }, Date.now() + 5000),
      (e) => e instanceof RouterError && e.kind === kind,
      `HTTP ${status}`,
    );
    assert.equal(requests.length, 1, `HTTP ${status}: no retry`);
  }
  const late = recordingFetch(() => ({}));
  await assert.rejects(routerClient(auth, late.fetchImpl).call({ endpoint: "e1", params: {} }, Date.now() - 1), (e) => e.kind === "timed out");
  const missing = recordingFetch(() => ({ status: 404, body: { error: "unknown_endpoint" } }));
  assert.equal(await routerClient(auth, missing.fetchImpl).endpoint("nope", Date.now() + 5000), null);
  console.log("ok client: HTTP 402 is 'usage wallet empty', and each other failure has its kind");
}

/** Write the route cache many times from two processes at once (task 2.2). */
function writerProcess(home, tag) {
  const script = `
    const store = await import(${JSON.stringify(path.join(repoRoot, "src", "contentRouter", "store.ts"))});
    for (let i = 0; i < 150; i++) {
      store.updateRoute("goal ${tag} " + (i % 5), () => ({ endpoint: "e-${tag}-" + i, queryInput: "query", fixedInputs: { pad: "x".repeat(2000) }, origin: "learned", learnedAt: "t", failures: 0 }), ${JSON.stringify(home)});
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

async function testStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-hermes-"));
  try {
    const dir = store.ensureContentCache(home);
    assert.equal(dir, path.join(home, "skills", "joshu-content-cache"));
    assert.match(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /^---\nname: joshu-content-cache/);
    const routes = store.readRoutes(home).routes;
    assert.equal(Object.keys(routes).length, 20, "5 default social goals and the 15 endpoints of joshu-social-posts");
    for (const kind of ["reddit posts", "youtube videos", "tiktok videos", "instagram reels", "x posts"]) assert.ok(routes[kind], kind);
    assert.equal(routes["instagram video transcript"].endpoint, "scrapecreators.x.v2-instagram-media-transcript");
    assert.equal(routes["instagram video transcript"].queryInput, "url");
    assert.equal(Object.values(routes).filter((r) => r.queryInput === "url").length, 15);
    assert.ok(Object.values(routes).every((r) => r.origin === "seed" && r.failures === 0));
    assert.equal(Object.keys(store.readShapes(home).shapes).length, 4, "the recipes of the four ScrapeCreators search endpoints");

    // A second ensure keeps what the box learned.
    store.updateRoute("Prediction  Market odds", () => ({ endpoint: "p", queryInput: "q", fixedInputs: {}, origin: "learned", learnedAt: "t", failures: 0 }), home);
    store.ensureContentCache(home);
    assert.equal(store.readRoutes(home).routes["prediction market odds"].endpoint, "p");

    await Promise.all([writerProcess(home, "a"), writerProcess(home, "b")]);
    const file = path.join(dir, "references", "routes.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.schemaVersion, 1, "two writers at once leave valid JSON");
    assert.ok(Object.keys(parsed.routes).some((k) => k.startsWith("goal a") || k.startsWith("goal b")));
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")), [], "no temporary file is left");
    console.log("ok box skill joshu-content-cache: made at first use, seeded, safe with two writers at once");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testRecipeReader() {
  const reply = polymarketReply();
  assert.equal(readPath(reply, "events.0.markets.0.outcomePrices.0"), "0.36", "a JSON string inside the reply is parsed");
  assert.equal(readPath(reply, ""), reply);
  assert.equal(readPath(reply, "events.9.title"), undefined);
  const recipe = checkRecipe(POLY_RECIPE);
  assert.ok(recipe && !recipe.publishedAt && !recipe.author);
  const items = applyRecipe(reply, recipe);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    url: "https://polymarket.com/event/democratic-presidential-nominee-2028",
    title: "Democratic Presidential Nominee 2028",
    text: "Will Gavin Newsom win the 2028 Democratic presidential nomination?",
    author: "",
    metrics: { odds: 0.36, volume: 412839210.52 },
  });
  assert.equal(checkRecipe({ list: "events", title: "title" }), null, "a recipe needs a url");
  assert.equal(checkRecipe("rm -rf /"), null);
  console.log("ok recipe reader: paths, templates, JSON strings, and the recipe check");
}

const POLY_GOAL = { id: "goal:prediction market odds", kind: "prediction market odds", label: "Prediction market odds", query: "2028 primaries", prefer: "Polymarket" };
const SEARCH = { sinceDay: "2026-10-02", today: "2026-11-01", deadline: Date.now() + 60_000 };
const NOW = () => new Date("2026-11-01T12:00:00.000Z");

async function testLearning() {
  const home = tempHermesHome();
  try {
    const router = fakeRouter();
    const model = learnModel();
    const deps = { client: router.client, llm: model.llm, home, now: NOW, hints: ["Polymarket for prediction market odds"] };

    // First use: one route model call and one recipe model call.
    const first = await resolveGoal(POLY_GOAL, SEARCH, deps);
    assert.equal(model.requests.length, 2, "one route model call and one recipe model call");
    assert.match(model.requests[0].messages[1].content, /Preferred provider: Polymarket/);
    assert.match(model.requests[0].messages[1].content, /success rate unknown/, "the route call sees the price and the health");
    assert.equal(first.endpoint, POLY_ENDPOINT.id);
    assert.deepEqual(router.calls[0], { endpoint: POLY_ENDPOINT.id, params: { limit_per_type: 5, q: "2028 primaries" } });
    assert.equal(first.state.state, "returned items");
    assert.equal(first.items.length, 3, "markets have no date, so all count");
    assert.equal(first.items[0].engagement.odds, 0.36);
    assert.equal(first.items[0].source, "goal:prediction market odds");
    const route = store.readRoutes(home).routes["prediction market odds"];
    assert.deepEqual([route.endpoint, route.queryInput, route.prefer, route.origin, route.failures], [POLY_ENDPOINT.id, "q", "Polymarket", "learned", 0]);
    assert.ok(store.readShapes(home).shapes[POLY_ENDPOINT.id], "the recipe is in the shape cache");

    // Second use with another query: no model call.
    const second = await resolveGoal({ ...POLY_GOAL, query: "2028 Iowa caucus" }, SEARCH, deps);
    assert.equal(model.requests.length, 2, "no model call on a second use");
    assert.equal(router.calls[1].params.q, "2028 Iowa caucus");
    assert.equal(second.items.length, 3);

    // The provider changes its reply: the recipe is learned again and replaced.
    const changed = fakeRouter({ replies: { [POLY_ENDPOINT.id]: () => ({ data: { results: polymarketReply().events } }) } });
    const relearn = learnModel({ recipe: { ...POLY_RECIPE, list: "data.results" } });
    const third = await resolveGoal(POLY_GOAL, SEARCH, { ...deps, client: changed.client, llm: relearn.llm });
    assert.equal(relearn.requests.length, 1, "one recipe model call, no route model call");
    assert.match(relearn.requests[0].messages[1].content, /The last recipe failed: no items/);
    assert.equal(third.items.length, 3);
    assert.equal(store.readShapes(home).shapes[POLY_ENDPOINT.id].list, "data.results");

    // Three failures in a row drop the route.
    const failing = fakeRouter({ fail: { [POLY_ENDPOINT.id]: "provider error" } });
    for (let i = 1; i <= 3; i++) {
      const r = await resolveGoal(POLY_GOAL, SEARCH, { ...deps, client: failing.client, llm: relearn.llm });
      assert.deepEqual([r.state.state, r.state.engineStatus], ["could not be reached", "provider error"]);
      const left = store.readRoutes(home).routes["prediction market odds"];
      if (i < 3) assert.equal(left.failures, i);
      else assert.equal(left, undefined, "dropped after three failures");
    }
    // An empty usage wallet is not a failure of the provider endpoint.
    store.updateRoute("reddit posts", (r) => r, home);
    const empty = fakeRouter({ failAll: "usage wallet empty" });
    const reddit = { id: "reddit", kind: "Reddit posts", label: "Reddit", query: "humanoid robots" };
    for (let i = 0; i < 3; i++) await resolveGoal(reddit, SEARCH, { ...deps, client: empty.client });
    assert.equal(store.readRoutes(home).routes["reddit posts"].failures, 0);

    // Without a client, the goal says why.
    const none = await resolveGoal(reddit, SEARCH, { client: null, unavailable: "no router API key", home });
    assert.deepEqual([none.state.state, none.state.engineStatus], ["could not be reached", "no router API key"]);
    console.log("ok learning: route and recipe learned once, no model call the second time, relearn on a new shape, route dropped after three failures");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function testRecipeCheck() {
  const home = tempHermesHome();
  try {
    // A recipe that maps the profile link instead of the link of each market.
    const profile = { ...POLY_RECIPE, url: "https://polymarket.com/profile/{markets.0.outcomes.0}" };
    store.saveShape(POLY_ENDPOINT.id, profile, "2026-11-01T00:00:00.000Z", home);
    store.updateRoute("prediction market odds", () => ({ endpoint: POLY_ENDPOINT.id, queryInput: "q", fixedInputs: {}, prefer: "Polymarket", origin: "learned", learnedAt: "t", failures: 0 }), home);
    const items = applyRecipe(polymarketReply(), profile);
    assert.deepEqual(checkItems(items, "2026-11-01", profile), { ok: false, reason: "3 items share 1 links" });

    const router = fakeRouter();
    const model = learnModel({ recipe: profile });
    const result = await resolveGoal(POLY_GOAL, SEARCH, { client: router.client, llm: model.llm, home, now: NOW });
    assert.equal(model.requests.length, 1, "one new learning");
    assert.match(model.requests[0].messages[1].content, /share 1 links/);
    assert.deepEqual([result.state.state, result.state.engineStatus, result.items.length], ["could not be reached", COULD_NOT_BE_READ, 0]);
    assert.equal(store.readRoutes(home).routes["prediction market odds"].failures, 1, "a goal that could not be read counts as a failure");

    // Dates after tomorrow fail the check, and so do items with no link.
    const dated = [{ url: "https://a/1", title: "a", text: "", author: "", publishedAt: "2027-01-01", metrics: {} }];
    assert.equal(checkItems(dated, "2026-11-01", { ...profile, publishedAt: { path: "d", format: "iso" } }).ok, false);
    assert.equal(checkItems([{ ...dated[0], url: "" }], "2026-11-01", profile).ok, false);
    console.log("ok recipe check: a profile link fails, one new learning, then 'could not be read'");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testDefaultGoals() {
  const skill = fs.readFileSync(path.join(repoRoot, "integrations", "hermes", "skills", "research", "joshu-content-router", "SKILL.md"), "utf8");
  const goals = parseDefaultGoals(skill);
  assert.deepEqual(goals.map((g) => g.id), ["reddit", "youtube", "tiktok", "instagram", "x"]);
  assert.deepEqual(goals, BUILT_IN_SOCIAL_GOALS, "the skill and the built-in list agree");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-hermes-"));
  try {
    assert.deepEqual(defaultSocialGoals(repoRoot, home), goals, "the copy of the release when the box has none");
    const boxCopy = path.join(home, "skills", "research", "joshu-content-router");
    fs.mkdirSync(boxCopy, { recursive: true });
    fs.writeFileSync(path.join(boxCopy, "SKILL.md"), "## Default social goals\n\n| Id | Goal | Label |\n|---|---|---|\n| reddit | Reddit posts | Reddit |\n| hn | Hacker News stories | Hacker News |\n");
    assert.deepEqual(defaultSocialGoals(repoRoot, home).map((g) => g.id), ["reddit", "hn"], "a new default is a skill change");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.equal(goalOfSource("youtube").kind, "YouTube videos", "an old source id maps to its goal");
  assert.equal(goalOfSource("goal:prediction market odds").label, "Prediction market odds");
  assert.equal(goalOfSource("web"), null);
  console.log("ok default social goals from skill joshu-content-router");
}

/** Security review, issue 1: a goal never learns a route to a costly or unchecked provider endpoint. */
async function testCostLimits() {
  const base = { provider: "P", provider_slug: "p", title: "t", capabilities: [], channels: [], served_via: "treg", success_rate_30d: null, median_latency_ms_30d: null, calls_30d: 0, price_varies: false };
  const endpoints = [
    { ...base, id: "ok.search", price_usd: 0.002 },
    { ...base, id: "varies.search", price_usd: 0.001, price_varies: true },
    { ...base, id: "treg.x.search.posts", price_usd: 0.001 },
    { ...base, id: "dear.search", price_usd: 0.05 },
    { ...base, id: "unpriced.search", price_usd: null },
    { ...base, id: "bad id; rm", price_usd: 0.001 },
  ];
  const client = {
    async search() {
      return { capabilities: [{ id: "x.search", kind: "data", endpoints }, { id: "video.generate", kind: "media", endpoints: [{ ...base, id: "fal.video.cheap", price_usd: 0.001 }] }] };
    },
  };
  assert.deepEqual((await learn.routeCandidates(client, "x posts", undefined, Date.now() + 5000)).map((e) => e.id), ["ok.search", "dear.search"], "data only, a known fixed price, no treg.");
  assert.equal(learn.goalEndpointAllowed("data", { id: "dear.search", price_usd: 0.05, price_varies: false }), true, "no price cap");

  // The model answer is checked against the JSON Schema of the endpoint.
  const detail = { id: "ok.search", inputs: { type: "object", properties: { query: {}, limit: {}, sort: {}, max_results: {} } } };
  const details = new Map([["ok.search", detail]]);
  assert.equal(learn.checkRouteAnswer({ endpoint: "ok.search", query_input: "q", fixed_inputs: {} }, details), null, "a query input that the schema does not have");
  assert.equal(learn.checkRouteAnswer({ endpoint: "other", query_input: "query" }, details), null, "an endpoint that is not a candidate");
  assert.deepEqual(
    learn.checkRouteAnswer({ endpoint: "ok.search", query_input: "query", fixed_inputs: { limit: 500, max_results: "200", sort: "top", unknown: 1, query: "x", nested: { a: 1 } } }, details),
    { endpoint: "ok.search", queryInput: "query", fixedInputs: { sort: "top" } },
    "unknown names, objects, and counts above 50 are left out",
  );
  assert.deepEqual(learn.cleanFixedInputs({ limit: 20, sort: "<script>" }), { limit: 20 });

  // A route cache entry that someone edited is checked before a paid call.
  assert.equal(goals.usableRoute({ endpoint: "treg.x.search.posts", queryInput: "q", fixedInputs: {}, failures: 0 }), null);
  assert.equal(goals.usableRoute({ endpoint: "a b", queryInput: "q", fixedInputs: {}, failures: 0 }), null);
  assert.deepEqual(goals.usableRoute({ endpoint: "ok.search", queryInput: "q", fixedInputs: { limit: 9999, sort: "top" }, failures: 0 }).fixedInputs, { sort: "top" });

  // At most five goal: sources.
  assert.equal(parseSources(["web", ...[1, 2, 3, 4, 5, 6].map((n) => `goal:kind ${n}`)]), null);
  assert.equal(parseSources(["web", ...[1, 2, 3, 4, 5].map((n) => `goal:kind ${n}`)]).length, 6);
  const home = tempHermesHome();
  try {
    const router = fakeRouter({ failAll: "usage wallet empty" });
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `goal:kind ${n}`, kind: `kind ${n}`, label: `Kind ${n}`, query: "q" }));
    const reddit = { id: "reddit", kind: "Reddit posts", label: "Reddit", query: "q" };
    const out = await goals.resolveGoals([reddit, ...many], SEARCH, { client: router.client, llm: learnModel().llm, home, now: NOW });
    assert.equal(out.sources.length, 8);
    assert.deepEqual(out.sources.filter((s) => s.engineStatus === goals.TOO_MANY_GOALS).map((s) => s.name), ["goal:kind 6", "goal:kind 7"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("ok cost limits: data endpoints at a fixed price under the cap, inputs checked against the schema, at most five goal sources");
}

/** Security review, issue 1: a new route that gives no items is remembered, so the next report does not pay again. */
async function testRememberedFailure() {
  const home = tempHermesHome();
  try {
    const router = fakeRouter({ replies: { [POLY_ENDPOINT.id]: () => ({ events: [] }) } });
    const model = learnModel();
    const deps = { client: router.client, llm: model.llm, home, now: NOW };
    const first = await resolveGoal(POLY_GOAL, SEARCH, deps);
    assert.equal(first.state.state, "returned no items");
    const entry = store.readRoutes(home).routes["prediction market odds"];
    assert.equal(entry.reason, "returned no items");
    assert.equal(entry.retryAfter, "2026-11-08T12:00:00.000Z", "blocked for seven days");
    const [learnCalls, routerCalls] = [model.requests.length, router.calls.length];
    const second = await resolveGoal(POLY_GOAL, SEARCH, deps);
    assert.deepEqual([second.state.state, second.state.engineStatus], ["could not be reached", goals.NO_ROUTE]);
    assert.deepEqual([model.requests.length, router.calls.length], [learnCalls, routerCalls], "no model call and no router call while blocked");
    // After seven days the box learns again.
    await resolveGoal(POLY_GOAL, SEARCH, { ...deps, now: () => new Date("2026-11-09T12:00:00.000Z") });
    assert.equal(model.requests.length, learnCalls + 1);

    // A model answer that fails the schema check is remembered too.
    store.updateRoute("x posts", () => undefined, home);
    const empty = fakeRouter({ catalog: [] });
    const none = await resolveGoal({ id: "x", kind: "X posts", label: "X", query: "q" }, SEARCH, { ...deps, client: empty.client });
    assert.equal(none.state.engineStatus, goals.NO_ROUTE);
    assert.ok(store.readRoutes(home).routes["x posts"].retryAfter);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("ok a route with no items is remembered for seven days, with no new learning and no new call");
}

/** Security review, issue 2: recipes are strict paths, and only the link can be an https template. */
function testStrictRecipes() {
  for (const [endpoint, recipe] of Object.entries(store.seedShapes().shapes)) assert.ok(checkRecipe(recipe), `seed ${endpoint}`);
  assert.ok(checkRecipe(POLY_RECIPE));
  const ok = { list: "items", url: "url", title: "title" };
  const bad = [
    { ...ok, list: "items; rm -rf" },
    { ...ok, title: "{title}" },
    { ...ok, url: "http://evil.example/{id}" },
    { ...ok, url: "javascript:alert(1)//{id}" },
    { ...ok, url: "https://evil.example/{id}<script>" },
    { ...ok, url: `https://a.example/${"x".repeat(200)}{id}` },
    { ...ok, text: ["a", "b", "c", "d", "e"] },
    { ...ok, author: "a".repeat(101) },
    { ...ok, metrics: { views: "$(id)" } },
    { ...ok, metrics: { "Views!": "v" } },
    { ...ok, publishedAt: { path: "{d}", format: "iso" } },
  ];
  for (const r of bad) assert.equal(checkRecipe(r), null, JSON.stringify(r).slice(0, 80));
  assert.ok(checkRecipe({ ...ok, url: "https://www.youtube.com/watch?v={id}" }));
  console.log("ok strict recipes: paths and https link templates only");
}

/** An optional field given as an empty list is "no field"; url and title stay required (a You.com web search, 2026-11-06). */
function testEmptyListFields() {
  // The answer of deepseek/deepseek-v4.1-flash for you.web.search that the box refused.
  const answer = { list: "results.web", url: "url", title: "title", text: "description", author: [], publishedAt: { path: "page_age", format: "iso" }, metrics: {} };
  const recipe = checkRecipe(answer);
  assert.ok(recipe, "a recipe with author [] is valid");
  assert.equal(recipe.author, undefined);
  assert.equal(recipe.metrics, undefined);
  const reply = {
    results: {
      web: [
        { url: "https://example.com/a", title: "First result", description: "About &quot;a&quot;", page_age: "2026-11-05T21:24:23", snippets: [] },
        { url: "https://example.com/b", title: "Second result", description: "About b", page_age: "2026-11-04T08:00:00", snippets: [] },
      ],
    },
  };
  const items = applyRecipe(reply, recipe);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { url: "https://example.com/a", title: "First result", text: 'About "a"', author: "", publishedAt: "2026-11-05", metrics: {} });
  assert.deepEqual(checkItems(items, "2026-11-06", recipe), { ok: true });

  // Other optional fields: an empty list is left out, and a date with no path means no date.
  const base = { list: "items", url: "url", title: "title" };
  assert.deepEqual(checkRecipe({ ...base, text: [], metrics: { views: [], likes: "likes" }, publishedAt: { path: [], format: "iso" } }), { ...base, metrics: { likes: "likes" } });
  // url and title stay required.
  for (const r of [{ ...base, url: [] }, { ...base, title: [] }, { ...base, url: "" }, { ...base, title: "" }, { list: "items", url: "url" }]) {
    assert.equal(checkRecipe(r), null, JSON.stringify(r));
  }
  // Too many paths and bad paths are still refused.
  assert.equal(checkRecipe({ ...base, author: ["a", "b", "c", "d", "e"] }), null);
  assert.equal(checkRecipe({ ...base, author: ["a", "$(id)"] }), null);
  assert.equal(checkRecipe({ ...base, metrics: { views: ["v", "{x}"] } }), null);
  console.log("ok empty optional fields: author [] counts as no author, url and title stay required");
}

async function testMedia() {
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-desktop-"));
  try {
    const calls = [];
    const client = {
      async call(request, _deadline, opts) {
        calls.push({ request, opts });
        const body = request.capability === "image.generate" ? { images: [{ url: "https://fal.media/files/a/b.png" }] } : { video: { url: "https://fal.media/files/c/d.mp4" } };
        return { call_id: "rc_1", endpoint: request.endpoint === "auto" ? "fal.image.flux" : request.endpoint, capability: request.capability, channel: "fal", cost_usd: 0.04, body: opts?.body ?? nextBody ?? body };
      },
      async endpoint(id) {
        const listed = { "fal.video.seedance-2-pro": ["video.generate"], "fal.image.nano-banana-pro": ["image.generate"], "scrapecreators.reddit.search.posts": ["reddit.search.posts"] };
        return listed[id] ? { id, capabilities: listed[id] } : null;
      },
    };
    let nextBody = null;
    const downloads = [];
    const fetchImpl = async (url, init) => {
      downloads.push({ url, init });
      return new Response(Buffer.from(url.endsWith(".png") ? "PNGDATA" : "MP4DATA"), { status: 200, headers: { "content-type": url.endsWith(".png") ? "image/png" : "video/mp4" } });
    };
    // fal.media is public; the other names point to the private network or to the box itself.
    const lookup = async (host) => ({ "fal.media": ["151.101.1.1"], "evil.example": ["10.0.0.5"], "rebind.example": ["93.184.216.34", "127.0.0.1"] })[host] ?? [];
    const deps = { client, desktopRoot: desktop, fetchImpl, lookup, now: NOW };

    const image = await makeMedia({ kind: "image", prompt: "a red bicycle", options: { aspect_ratio: "square" } }, deps);
    assert.equal(image.ok, true);
    assert.deepEqual(calls[0].request, { endpoint: "auto", capability: "image.generate", params: { aspect_ratio: "square", prompt: "a red bicycle" } });
    assert.equal(fs.readFileSync(image.path, "utf8"), "PNGDATA");
    assert.equal(path.dirname(image.path), desktop, "the file is on the Desktop");
    assert.match(image.desktopPath, /^image-20261101-120000-[0-9a-f]{6}\.png$/);

    const video = await makeMedia({ kind: "video", prompt: "a red bicycle in the rain", endpoint: "fal.video.seedance-2-pro" }, deps);
    assert.equal(video.ok, true);
    assert.deepEqual(calls[1].request, { endpoint: "fal.video.seedance-2-pro", capability: "video.generate", params: { prompt: "a red bicycle in the rain" } });
    assert.equal(calls[1].opts.timeoutMs, 600_000, "a video may take ten minutes");
    assert.ok(video.path.endsWith(".mp4"));

    // Download checks (security review): https only, public hosts, each redirect, and the byte limit.
    assert.equal(downloads[0].init.redirect, "manual", "the box follows no redirect without a check");
    for (const [link, reason] of [
      ["http://fal.media/files/a.png", /not https/],
      ["https://evil.example/a.png", /not public/],
      ["https://rebind.example/a.png", /not public/],
      ["https://127.0.0.1/a.png", /not public/],
      ["https://[::1]/a.png", /not public/],
      ["https://169.254.169.254/latest/meta-data", /not public/],
      ["https://localhost/a.png", /not public/],
    ]) {
      nextBody = { images: [{ url: link }] };
      const r = await makeMedia({ kind: "image", prompt: "x" }, deps);
      assert.equal(r.ok, false, link);
      assert.match(r.error, reason, link);
    }
    nextBody = { images: [{ url: "https://fal.media/files/redirect.png" }] };
    const redirecting = async (url, init) => {
      downloads.push({ url, init });
      if (url.endsWith("redirect.png")) return new Response(null, { status: 302, headers: { location: "https://127.0.0.1:8788/joshu/api/secret.png" } });
      return new Response(Buffer.from("PNGDATA"), { status: 200, headers: { "content-type": "image/png" } });
    };
    const redirected = await makeMedia({ kind: "image", prompt: "x" }, { ...deps, fetchImpl: redirecting });
    assert.match(redirected.error, /127\.0\.0\.1 is not public/, "a redirect to the box itself is refused");
    assert.ok(!downloads.some((d) => d.url.includes("127.0.0.1")), "the box never fetched the private link");
    nextBody = { images: [{ url: "https://fal.media/files/huge.png" }] };
    const declaredHuge = async () => new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "image/png", "content-length": String(26 * 1024 * 1024) } });
    assert.match((await makeMedia({ kind: "image", prompt: "x" }, { ...deps, fetchImpl: declaredHuge })).error, /too large/);
    const streamedHuge = async () => new Response(new ReadableStream({
      pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); },
    }), { status: 200, headers: { "content-type": "image/png" } });
    assert.match((await makeMedia({ kind: "image", prompt: "x" }, { ...deps, fetchImpl: streamedHuge })).error, /too large/, "the stream stops at 25 MB");
    nextBody = null;

    // An explicit provider endpoint must be listed in the router catalog under the capability.
    const before = calls.length;
    const unlisted = await makeMedia({ kind: "video", prompt: "x", endpoint: "scrapecreators.reddit.search.posts" }, deps);
    assert.deepEqual([unlisted.ok, unlisted.status], [false, 400]);
    const unknown = await makeMedia({ kind: "image", prompt: "x", endpoint: "fal.image.does-not-exist" }, deps);
    assert.deepEqual([unknown.ok, unknown.status], [false, 400]);
    assert.equal(calls.length, before, "no router call for an endpoint that the catalog does not list");
    assert.equal((await makeMedia({ kind: "image", prompt: "x", endpoint: "fal.image.nano-banana-pro" }, deps)).ok, true);

    const empty = await makeMedia({ kind: "image", prompt: "x" }, { ...deps, client: { call: async () => { throw new RouterError("usage wallet empty", "empty"); } } });
    assert.deepEqual([empty.ok, empty.status, empty.kind], [false, 402, "usage wallet empty"]);
    const off = await makeMedia({ kind: "image", prompt: "x" }, { ...deps, client: null, unavailable: "content router off" });
    assert.deepEqual([off.ok, off.status], [false, 503]);

    assert.equal(parseMediaRequest({ kind: "audio", prompt: "x" }), "kind must be image or video");
    assert.equal(parseMediaRequest({ kind: "image" }), "prompt is required");
    assert.deepEqual(parseMediaRequest({ kind: "video", prompt: " p ", endpoint: "auto" }), { kind: "video", prompt: "p", options: {} });

    // The route: a fake express router.
    const handlers = {};
    registerRouterMediaRoutes({ post: (p, h) => (handlers[p] = h) }, { projectRoot: repoRoot, allowRequest: () => true, media: (r) => makeMedia(r, deps) });
    const send = async (body) => {
      const res = { code: 200, json(v) { this.body = v; return this; }, status(c) { this.code = c; return this; } };
      await handlers["/api/router/media"]({ body }, res);
      return res;
    };
    const bad = await send({ kind: "image" });
    assert.deepEqual([bad.code, bad.body.ok], [400, false]);
    const good = await send({ kind: "image", prompt: "a red bicycle" });
    assert.deepEqual([good.code, good.body.ok, good.body.endpoint], [200, true, "fal.image.flux"]);
    console.log("ok media route: image and video through the content router, saved on the Desktop, safe download, listed endpoints only");
  } finally {
    fs.rmSync(desktop, { recursive: true, force: true });
  }
}

await testClientAuth();
await testClientFailures();
await testStore();
testRecipeReader();
await testLearning();
await testRecipeCheck();
testDefaultGoals();
await testCostLimits();
await testRememberedFailure();
testStrictRecipes();
testEmptyListFields();
await testMedia();
resetEnv();
fs.rmSync(stateDir, { recursive: true, force: true });
console.log("content router: all tests passed");
