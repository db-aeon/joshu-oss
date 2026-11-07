/**
 * Unit tests of the social sources (change content-router, task 3.1; before it, change
 * recurring-research-reports, tasks 1.1 to 1.3): each social source is a content goal that goes
 * through the content router. The tests use a fake content router with the saved replies of the
 * five default goals of 2026-10-29, and check the router call of each goal, the items, the date
 * filter, each failure kind, the HTTP 402 message, one source row for each goal, and the social box
 * of a Research report. No network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dayOf } from "../src/contentRouter/recipe.ts";
import { availableSocialSources, goalsOfSources, searchSocial, socialGoalKinds } from "../src/research/social/sources.ts";
import { collectSocialPool, periodStart, POOL_POSTS_PER_SOURCE } from "../src/research/social/pool.ts";
import { socialSourcesHealth } from "../src/research/social/health.ts";
import { sourceListHtml } from "../src/research/template.ts";
import { fakeRouter, learnAnswer, POLY_ENDPOINT, SOCIAL_ENDPOINTS, tempHermesHome } from "./lib/content-router-fakes.mjs";

const SEARCH = { query: "humanoid robots", sinceDay: "2026-10-22", days: 7, deadline: Date.now() + 10_000 };
const homes = [];
function home() {
  const h = tempHermesHome();
  homes.push(h);
  return h;
}

/** The default social goals of skill joshu-content-router. */
const GOALS = socialGoalKinds({ projectRoot: process.cwd(), home: "/nonexistent" });

async function testRouterCalls() {
  const router = fakeRouter();
  await searchSocial(GOALS, SEARCH, { client: router.client, home: home() });
  assert.equal(router.calls.length, 5, "one router call for each goal, no comments or transcripts");
  const byEndpoint = Object.fromEntries(router.calls.map((c) => [c.endpoint, c.params]));
  assert.deepEqual(Object.keys(byEndpoint).sort(), Object.keys(SOCIAL_ENDPOINTS).sort(), "the provider endpoints of the seed of the route cache");
  assert.deepEqual(byEndpoint["scrapecreators.reddit.search.posts"], { sort: "top", timeframe: "month", query: "humanoid robots" });
  assert.deepEqual(byEndpoint["scrapecreators.tiktok.search.videos"], { sort_by: "relevance", date_posted: "this-month", query: "humanoid robots" });
  assert.equal(byEndpoint["anyapi.x.search.posts"].query, "humanoid robots");
  console.log("ok one router call for each default goal, with the route cache seed");
}

async function testItems() {
  const router = fakeRouter();
  const all = await searchSocial(GOALS, { ...SEARCH, sinceDay: "2026-01-01", days: 365 }, { client: router.client, home: home() });
  const by = (s) => all.posts.filter((p) => p.source === s);

  const reddit = by("reddit");
  assert.equal(reddit.length, 4);
  assert.ok(reddit.every((p) => p.url.startsWith("https://www.reddit.com/r/") && /^\d{4}-\d{2}-\d{2}$/.test(p.publishedAt)));
  assert.ok(reddit.every((p) => p.engagement.score > 0 && typeof p.engagement.comments === "number"), "score and number of comments");

  const youtube = by("youtube");
  assert.equal(youtube.length, 4);
  assert.ok(youtube.every((p) => p.url.startsWith("https://www.youtube.com/watch?v=") && p.engagement.views > 0 && p.summary.length > 0), "the channel is the author");

  const tiktok = by("tiktok");
  assert.equal(tiktok.length, 5);
  assert.ok(tiktok.every((p) => /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/.test(p.url)), "clean TikTok links without tracking");
  assert.ok(tiktok.every((p) => "views" in p.engagement && "likes" in p.engagement));

  const instagram = by("instagram");
  assert.equal(instagram.length, 4);
  assert.ok(instagram.every((p) => p.url.startsWith("https://www.instagram.com/reel/") && "likes" in p.engagement));

  const x = by("x");
  assert.equal(x.length, 4);
  assert.ok(x.every((p) => /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(p.url) && "likes" in p.engagement && "reposts" in p.engagement));
  assert.equal(x[0].publishedAt, "2026-10-26", "the date form of X");

  assert.deepEqual(all.sources.map((s) => [s.name, s.label, s.state]), GOALS.map((g) => [g.id, g.label, "returned items"]), "one source row for each goal");
  console.log("ok items of each saved reply, one source row for each goal");
}

async function testDateFilter() {
  const router = fakeRouter();
  const tiktok = GOALS.filter((g) => g.id === "tiktok");
  const { posts, sources } = await searchSocial(tiktok, SEARCH, { client: router.client, home: home() });
  assert.equal(posts.length, 2, "the three TikTok videos from before October 22 are left out");
  assert.ok(posts.every((p) => p.publishedAt >= "2026-10-22"));
  assert.equal(sources[0].state, "returned items");
  assert.equal(dayOf(1793037906, "epoch_s"), "2026-10-26");
  assert.equal(dayOf("Fri Oct 30 02:00:01 +0000 2026"), "2026-10-30");
  assert.equal(dayOf("nonsense"), undefined);
  assert.equal(periodStart("2026-10-29", 7), "2026-10-22");
  console.log("ok date filter");
}

async function testFailures() {
  for (const kind of ["error", "rate limited", "timed out", "provider error", "no channel available"]) {
    const router = fakeRouter({ fail: { "scrapecreators.tiktok.search.videos": kind } });
    const result = await searchSocial(GOALS, SEARCH, { client: router.client, home: home() });
    const tiktok = result.sources.find((s) => s.name === "tiktok");
    assert.deepEqual([tiktok.state, tiktok.engineStatus], ["could not be reached", kind], kind);
    assert.ok(result.posts.some((p) => p.source === "reddit"), `${kind}: the other goals still give posts`);
  }
  // No content router: each social source says why, and the box makes no call.
  const none = await searchSocial(GOALS, SEARCH, { client: null, unavailable: "no router API key", home: home() });
  assert.ok(none.sources.every((s) => s.state === "could not be reached" && s.engineStatus === "no router API key"));
  assert.match(sourceListHtml(none.sources), /Reddit: could not be reached, the social sources need a router API key in Connectors/);
  assert.deepEqual(availableSocialSources({ client: null }), [], "no social source without the content router");
  assert.deepEqual(availableSocialSources({ client: fakeRouter().client, home: "/nonexistent" }), ["reddit", "youtube", "tiktok", "instagram", "x"]);
  console.log("ok failures give 'could not be reached' and never fail the caller");
}

async function testUsageWalletEmpty() {
  // The content router answers HTTP 402 when the usage wallet of the owner is too low.
  const router = fakeRouter({ fail: { "scrapecreators.reddit.search.posts": "usage wallet empty", "scrapecreators.tiktok.search.videos": "usage wallet empty" } });
  const goals = goalsOfSources(["reddit", "tiktok", "youtube"], { home: "/nonexistent" });
  const { sources } = await searchSocial(goals, SEARCH, { client: router.client, home: home() });
  assert.equal(router.calls.length, 3, "one request for each goal, no retry");
  const byName = Object.fromEntries(sources.map((s) => [s.name, s]));
  for (const name of ["reddit", "tiktok"]) {
    assert.equal(byName[name].state, "could not be reached");
    assert.equal(byName[name].engineStatus, "usage wallet empty");
  }
  assert.equal(byName.youtube.state, "returned items", "the other goals continue");

  const previous = process.env.CONTROL_PLANE_URL;
  process.env.CONTROL_PLANE_URL = "https://cp.example";
  const html = sourceListHtml(sources);
  if (previous === undefined) delete process.env.CONTROL_PLANE_URL;
  else process.env.CONTROL_PLANE_URL = previous;
  assert.match(html, /Reddit: could not be reached, the usage wallet is empty \(<a href="https:\/\/cp\.example\/joshu#usage-billing">add money<\/a>\)/);
  assert.match(html, /TikTok: could not be reached, the usage wallet is empty/);
  assert.doesNotMatch(html, /YouTube: could not be reached/);
  console.log("ok HTTP 402: no retry, engine status usage wallet empty, source list links to usage billing");
}

async function testSocialPool() {
  // The social posts of a Research report join the pool of the report (change research-report-topics):
  // the posts of each goal with the most engagement, and no model call, because the group step
  // leaves out the posts that are off topic.
  const h = home();
  const router = fakeRouter();
  const all = await searchSocial(GOALS, { ...SEARCH, sinceDay: "2026-01-01", days: 30 }, { client: router.client, home: h });
  const pool = await collectSocialPool("humanoid robots", "2026-10-30", Date.now() + 10_000, { client: router.client, home: h });
  assert.ok(pool.posts.length > 5, "more posts than the old box of five");
  const perSource = pool.posts.reduce((m, p) => m.set(p.source, (m.get(p.source) ?? 0) + 1), new Map());
  assert.ok([...perSource.values()].every((n) => n <= POOL_POSTS_PER_SOURCE), "at most ten posts from one source");
  assert.ok(pool.posts.every((p) => p.engagement && Object.values(p.engagement).some((v) => v > 0)), "a post of a default goal has an engagement number");
  assert.ok(pool.posts.length <= all.posts.length);
  assert.deepEqual(pool.posts.slice(0, 2).map((p) => p.id), ["s1", "s2"]);
  assert.equal(pool.sources.length, 5, "one source row for each goal");

  // An extra goal of a hint: its items join the pool with their odds.
  const odds = { id: "goal:prediction market odds", kind: "prediction market odds", label: "Prediction market odds", query: "2028 primaries", prefer: "Polymarket" };
  // The learning calls of the content goals client for the new goal kind.
  const learn = async (_url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(learnAnswer(body.messages[0].content, body.messages[1].content)) } }] }) };
  };
  const llm = { fetchImpl: learn, apiKey: "k", model: "m" };
  const withOdds = await collectSocialPool("2028 primaries", "2026-10-30", Date.now() + 10_000, { client: router.client, home: h, llm, goals: [...GOALS, odds] });
  const markets = withOdds.posts.filter((p) => p.source === odds.id);
  assert.ok(markets.length >= 1, "the items of the extra goal");
  assert.ok(markets.every((p) => p.engagement.odds > 0 && p.url.startsWith("https://polymarket.com/event/")));
  assert.ok(router.calls.some((c) => c.endpoint === POLY_ENDPOINT.id && c.params.q === "2028 primaries"), "the extra goal has its own query");
  assert.equal(withOdds.sources.length, 6);
  console.log("ok social pool: the strongest posts of each goal, extra goal with odds, no model call");
}

function testHealth() {
  // The provision file of a real box must not leak into the test.
  process.env.JOSHU_COMPOSE_ENV_FILE = "/nonexistent/instance.env";
  const keys = ["JOSHU_ROUTER_MODE", "JOSHU_ROUTER_RELAY_URL", "JOSHU_INSTANCE_ID", "INSTANCE_AGENT_TOKEN", "JOSHU_ROUTER_API_KEY", "JOSHU_STATE_DIR"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.JOSHU_STATE_DIR = "/nonexistent/state";
    const none = socialSourcesHealth();
    assert.equal(none.ok, true, "a box without the content router is still healthy");
    assert.deepEqual([none.router.configured, none.router.reason, none.sources], [false, "no router API key", []]);
    Object.assign(process.env, { JOSHU_ROUTER_MODE: "relay", JOSHU_ROUTER_RELAY_URL: "https://cp.example/r", JOSHU_INSTANCE_ID: "inst-1", INSTANCE_AGENT_TOKEN: "tok" });
    const fleet = socialSourcesHealth();
    assert.deepEqual([fleet.router.mode, fleet.router.kind], ["relay", "agent token"]);
    assert.deepEqual(fleet.sources, ["reddit", "youtube", "tiktok", "instagram", "x"]);
    console.log("ok health of the social sources: with and without the content router");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

try {
  testHealth();
  await testRouterCalls();
  await testItems();
  await testDateFilter();
  await testFailures();
  await testUsageWalletEmpty();
  await testSocialPool();
} finally {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}
console.log("research social: all tests passed");
