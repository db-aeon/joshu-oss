#!/usr/bin/env npx tsx
/**
 * Tests: the web backend of Hermes and the web routes of the Joshu API (change you-web-provider).
 *
 * - `POST /api/web/search` and `POST /api/web/extract` run the call with the web client of the
 *   box, return the shape that plugin joshu-web-you expects, and refuse a request from outside.
 * - A box that can reach You.com gets `web.backend: you` and plugin joshu-web-you.
 * - With an Exa key too, the Exa backend stays enabled, because it is the fallback.
 * - Only an Exa key keeps Exa, and neither changes nothing.
 *
 * Usage: npm run test:hermes-web-backend
 */
import assert from "node:assert/strict";
import { applyWebBackend, HERMES_WEB_YOU_PLUGIN } from "../src/hermesApi.ts";
import { registerWebProviderRoutes } from "../src/webProvider/routes.ts";

// You.com access and an Exa key: You.com is the backend, and both plugins are enabled.
let config = { web: { backend: "exa", search_backend: "exa", extract_backend: "tavily" }, plugins: { enabled: ["joshu-research"], disabled: [HERMES_WEB_YOU_PLUGIN, "web-exa"] } };
assert.equal(applyWebBackend(config, { you: true, exa: "exa-key" }), true);
assert.deepEqual(config.web, { backend: "you" }, "the per-capability overrides of another backend are removed");
assert.deepEqual(config.plugins.enabled, ["joshu-research", "web-exa", HERMES_WEB_YOU_PLUGIN]);
assert.deepEqual(config.plugins.disabled, []);
assert.equal(applyWebBackend(config, { you: true, exa: "exa-key" }), false, "a second run changes nothing");

// Only You.com access: no Exa plugin is added.
config = {};
assert.equal(applyWebBackend(config, { you: true, exa: "" }), true);
assert.deepEqual(config, { web: { backend: "you" }, plugins: { enabled: [HERMES_WEB_YOU_PLUGIN] } });

// Only an Exa key: Exa, as before this change.
config = { web: { backend: "you", search_backend: "you" } };
assert.equal(applyWebBackend(config, { you: false, exa: "exa-key" }), true);
assert.deepEqual(config.web, { backend: "exa" });
assert.deepEqual(config.plugins.enabled, ["web-exa"]);

// Neither: the config of the owner stays.
config = { web: { backend: "tavily" } };
assert.equal(applyWebBackend(config, { you: false, exa: "" }), false);
assert.deepEqual(config, { web: { backend: "tavily" } });

console.log("ok Hermes web backend: You.com first, Exa as the fallback");

// --- The web routes of the Joshu API.
function fakeRes() {
  return {
    code: 200,
    body: undefined,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}
const calls = [];
let boxClient = {
  provider: "you.com",
  client: {
    async search(req) {
      calls.push(["search", req]);
      if (req.query === "boom") throw new Error("You.com /v1/search answered 500");
      return [
        { url: "https://a.example/1", title: "One", highlights: ["first", "second"] },
        { url: "https://a.example/2" },
        { url: "https://a.example/3", title: "Three", highlights: ["third"] },
      ];
    },
    async contents(urls, _deadline, opts) {
      calls.push(["contents", urls, opts]);
      return [
        { url: urls[0], title: "Page", text: "text of the page" },
        { url: "https://a.example/empty", text: "  " },
      ];
    },
  },
};
let allow = true;
const handlers = {};
registerWebProviderRoutes(
  { post: (path, handler) => (handlers[path] = handler) },
  { projectRoot: "/unused", webClient: () => boxClient, allowRequest: () => allow },
);
const call = async (path, body) => {
  const res = fakeRes();
  await handlers[path]({ body }, res);
  return res;
};

let res = await call("/api/web/search", { query: " ebikes ", limit: 2 });
assert.deepEqual(calls.at(-1), ["search", { query: "ebikes", numResults: 2 }]);
assert.deepEqual(res.body, {
  ok: true,
  provider: "you.com",
  web: [
    { url: "https://a.example/1", title: "One", description: "first second", position: 1 },
    { url: "https://a.example/2", title: "", description: "", position: 2 },
  ],
});
// A long passage text is cut for the description of the companion.
boxClient.client.search = async (req) => {
  calls.push(["search", req]);
  if (req.query === "boom") throw new Error("You.com /v1/search answered 500");
  return [{ url: "https://a.example/long", title: "Long", highlights: ["x".repeat(900), "y".repeat(900)] }];
};
res = await call("/api/web/search", { query: "long" });
assert.equal(res.body.web[0].description.length, 600);
res = await call("/api/web/search", { query: "q", limit: 500 });
assert.equal(calls.at(-1)[1].numResults, 20, "at most 20 results");
res = await call("/api/web/search", { query: "  " });
assert.equal(res.code, 400);
res = await call("/api/web/search", { query: "boom" });
assert.equal(res.code, 502);
assert.match(res.body.error, /web search failed: You\.com \/v1\/search answered 500/);

res = await call("/api/web/extract", { urls: ["https://a.example/1", "https://a.example/empty", "ftp://x.example", 7] });
assert.deepEqual(calls.at(-1), ["contents", ["https://a.example/1", "https://a.example/empty"], { maxCharacters: 60_000 }], "only http and https URLs");
assert.deepEqual(res.body, { ok: true, provider: "you.com", pages: [{ url: "https://a.example/1", title: "Page", content: "text of the page" }] }, "a page with no text is left out");
assert.equal((await call("/api/web/extract", { urls: [] })).code, 400);
assert.equal((await call("/api/web/extract", { urls: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) })).code, 400, "at most 10 pages");

// A box that has no web provider, and a request that is not from the desktop or from localhost.
boxClient = { client: null, reason: "the box has no You.com access and no Exa key for web search" };
res = await call("/api/web/search", { query: "q" });
assert.equal(res.code, 503);
assert.match(res.body.error, /no You\.com access and no Exa key/);
allow = false;
assert.equal((await call("/api/web/search", { query: "q" })).code, 403);
assert.equal((await call("/api/web/extract", { urls: ["https://a.example/1"] })).code, 403);

console.log("ok web routes of the Joshu API: search, extract, limits, no provider, forbidden");

