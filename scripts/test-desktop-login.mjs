#!/usr/bin/env npx tsx
/**
 * Admin desktop login (openspec change admin-desktop-login): the one-time code
 * routes of the Joshu API. No network access outside loopback.
 */
import assert from "node:assert/strict";
import { once } from "node:events";

const { DesktopLoginCodes, registerDesktopLoginRoutes } = await import("../src/desktopLogin.ts");
const express = (await import("express")).default;

let clock = 1_000_000;
const codes = new DesktopLoginCodes(() => clock);
let ownerUser = "alex@example.com";
let boxHost = "sample.box.joshu.me";
const app = express();
app.use(express.json());
const router = express.Router();
registerDesktopLoginRoutes(router, { ownerUser: () => ownerUser, boxHost: () => boxHost, codes });
app.use("/joshu", router);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

async function post(path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/joshu${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

try {
  // A code from the agent: a link to the ArozOS login page of the box.
  const made = await post("/api/desktop-login/code", { adminEmail: "admin@example.com" });
  assert.equal(made.status, 200);
  const url = new URL(made.json.url);
  assert.equal(url.origin, "https://sample.box.joshu.me");
  assert.equal(url.pathname, "/system/auth/joshu-login");
  const code = url.searchParams.get("code");
  assert.ok(code && code.length >= 40, "the code is long and random");

  // ArozOS redeems the code one time, for the owner user only.
  const first = await post("/api/desktop-login/redeem", { code });
  assert.deepEqual(first, { status: 200, json: { ok: true, username: "alex@example.com" } });
  const second = await post("/api/desktop-login/redeem", { code });
  assert.equal(second.status, 401, "a code works one time");
  assert.equal((await post("/api/desktop-login/redeem", { code: "" })).status, 401);
  assert.equal((await post("/api/desktop-login/redeem", { code: "guess" })).status, 401);

  // A code expires after two minutes.
  const late = new URL((await post("/api/desktop-login/code", {})).json.url).searchParams.get("code");
  clock += 2 * 60_000 + 1;
  assert.equal((await post("/api/desktop-login/redeem", { code: late })).status, 401, "an old code does not work");

  // Requests through Caddy (forwarded headers) are refused, for both routes.
  const viaProxy = { "X-Forwarded-For": "203.0.113.9" };
  assert.equal((await post("/api/desktop-login/code", {}, viaProxy)).status, 403);
  const fresh = new URL((await post("/api/desktop-login/code", {})).json.url).searchParams.get("code");
  assert.equal((await post("/api/desktop-login/redeem", { code: fresh }, viaProxy)).status, 403);
  assert.equal((await post("/api/desktop-login/redeem", { code: fresh })).status, 200, "a refused request does not use the code");

  // Without the owner user or the box host, no code.
  ownerUser = "";
  assert.equal((await post("/api/desktop-login/code", {})).status, 503);
  ownerUser = "alex@example.com";
  boxHost = "";
  assert.equal((await post("/api/desktop-login/code", {})).status, 503);
} finally {
  server.close();
}
console.log("desktop-login: ok");
