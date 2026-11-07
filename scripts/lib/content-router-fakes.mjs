/**
 * Fakes of the content router for the tests of change content-router: a fake router client with
 * a small router catalog, the saved replies of the five default social goals (the provider replies
 * of 2026-10-29 without the relay envelope), a Polymarket reply, a temporary HERMES_HOME with the
 * box skill `joshu-content-cache`, and a fake model that answers the two learning calls. No network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RouterError } from "../../src/contentRouter/client.ts";
import { ensureContentCache, saveShape } from "../../src/contentRouter/store.ts";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const SOCIAL = path.join(ROOT, "test", "fixtures", "research", "social");
const ROUTER = path.join(ROOT, "test", "fixtures", "content-router");

/** The reply of the provider in a saved answer of the social sources (the `json` of the relay envelope). */
export function socialReply(name) {
  const saved = JSON.parse(fs.readFileSync(path.join(SOCIAL, `${name}.json`), "utf8"));
  return saved.json ?? saved;
}

export function polymarketReply() {
  return JSON.parse(fs.readFileSync(path.join(ROUTER, "polymarket-search.json"), "utf8"));
}

/** The provider endpoint of each default social goal in the seed of the route cache, and its saved reply. */
export const SOCIAL_ENDPOINTS = {
  "scrapecreators.reddit.search.posts": "reddit",
  "scrapecreators.x.v1-youtube-search": "youtube",
  "scrapecreators.tiktok.search.videos": "tiktok",
  "scrapecreators.x.v2-instagram-reels-search": "instagram",
  "anyapi.x.search.posts": "x",
};

/** The recipe of the saved X reply (the seed has none, so tests set it). */
export const X_RECIPE = {
  list: "tweets",
  url: "https://x.com/{author.username}/status/{id}",
  title: "text",
  author: "author.username",
  publishedAt: { path: "createdAt", format: "text" },
  metrics: { views: "viewCount", likes: "likeCount", reposts: "retweetCount", replies: "replyCount" },
};

/** The recipe that the fake model writes for the Polymarket reply. */
export const POLY_RECIPE = {
  list: "events",
  url: "https://polymarket.com/event/{slug}",
  title: "title",
  text: "markets.0.question",
  author: "",
  publishedAt: null,
  metrics: { odds: "markets.0.outcomePrices.0", volume: "volume" },
};

export const POLY_ENDPOINT = {
  id: "polymarket.events.search",
  provider: "Polymarket",
  provider_slug: "polymarket",
  title: "Search Polymarket events",
  capabilities: ["prediction.markets.search"],
  price_usd: 0.0011,
  price_varies: false,
  channels: ["direct"],
  served_via: "direct",
  success_rate_30d: null,
  median_latency_ms_30d: null,
  calls_30d: 0,
};

const VALYU_ENDPOINT = {
  ...POLY_ENDPOINT,
  id: "valyu.markets.predictions.search",
  provider: "Valyu",
  provider_slug: "valyu",
  title: "Prediction market search (Valyu)",
  price_usd: 0.055,
  channels: ["treg"],
  served_via: "treg",
};

/** A temporary HERMES_HOME with the box skill `joshu-content-cache` (and the X recipe unless `xRecipe` is false). */
export function tempHermesHome(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-content-cache-"));
  ensureContentCache(home);
  if (opts.xRecipe !== false) saveShape("anyapi.x.search.posts", X_RECIPE, "2026-11-01T00:00:00.000Z", home);
  return home;
}

/**
 * A fake router client. `replies` maps a provider endpoint to its body (or a function of the
 * params); `fail` maps a provider endpoint to a failure kind or a function that returns one.
 */
export function fakeRouter(opts = {}) {
  const calls = [];
  const searches = [];
  const replies = {
    ...Object.fromEntries(Object.entries(SOCIAL_ENDPOINTS).map(([id, name]) => [id, () => socialReply(name)])),
    [POLY_ENDPOINT.id]: () => polymarketReply(),
    ...opts.replies,
  };
  const catalog = opts.catalog ?? [POLY_ENDPOINT, VALYU_ENDPOINT];
  return {
    calls,
    searches,
    client: {
      async call(request) {
        calls.push(request);
        const fail = typeof opts.fail?.[request.endpoint] === "function" ? opts.fail[request.endpoint](calls) : opts.fail?.[request.endpoint];
        if (opts.failAll) throw new RouterError(opts.failAll, `fake ${opts.failAll}`);
        if (fail) throw new RouterError(fail, `fake ${fail}`);
        const reply = replies[request.endpoint];
        if (!reply) throw new RouterError("unknown endpoint", "unknown_endpoint");
        const body = typeof reply === "function" ? reply(request.params, calls) : reply;
        return { call_id: `rc_${calls.length}`, endpoint: request.endpoint, capability: "x", channel: "treg", cost_usd: 0.002, body };
      },
      async search(q) {
        searches.push(q);
        const words = q.toLowerCase().split(/\s+/);
        const found = catalog.filter((e) => words.some((w) => `${e.id} ${e.provider} ${e.title}`.toLowerCase().includes(w)));
        return { query: q, checked_at: "2026-11-01T11:00:00Z", markup_percent: 10, capabilities: found.length ? [{ id: "prediction.markets.search", title: "Prediction markets", description: "", kind: "data", endpoints: found }] : [] };
      },
      async endpoint(id) {
        const e = catalog.find((c) => c.id === id);
        return e ? { ...e, inputs: { type: "object", properties: { q: { type: "string" }, limit_per_type: { type: "number" } }, required: ["q"] }, example_reply: null, offers: [], checked_at: "2026-11-01T11:00:00Z" } : null;
      },
    },
  };
}

/** The candidate ids of a route model call. */
export function routeCandidateIds(user) {
  return [...user.matchAll(/^- ([^\s]+) \(/gm)].map((m) => m[1]);
}

/**
 * Answer a learning call of the content goals client, or return null for another call. The route
 * call picks the Polymarket endpoint when it is a candidate; the recipe call returns `recipe`.
 */
export function learnAnswer(system, user, recipe = POLY_RECIPE) {
  if (system.startsWith("You pick one provider endpoint")) {
    const ids = routeCandidateIds(user);
    const endpoint = ids.find((id) => id.includes("polymarket")) ?? ids[0];
    return { endpoint, query_input: "q", fixed_inputs: { limit_per_type: 5 } };
  }
  if (system.startsWith("You write a shape recipe")) return typeof recipe === "function" ? recipe(user) : recipe;
  return null;
}

/** A fake OpenRouter for the learning calls only. `requests` gets each request body. */
export function learnModel(opts = {}) {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answer = learnAnswer(body.messages[0].content, body.messages[1].content, opts.recipe);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer ?? {}) } }] }) };
  };
  return { requests, llm: { fetchImpl, apiKey: "sk-test", model: "test/model" } };
}
