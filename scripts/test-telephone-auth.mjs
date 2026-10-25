#!/usr/bin/env npx tsx
/**
 * Telephone settings access: GET and PUT /api/telephone and the passphrase route
 * need a desktop session when the request comes through Caddy, the status never
 * holds the passphrase, and the voice service route keeps its own service key.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

const BOX = "box.example.test";
const GOOD_COOKIE = "session-cookie=owner-session-ok";
const temp = await mkdtemp(path.join(tmpdir(), "joshu-telephone-auth-"));
Object.assign(process.env, {
  AROZ_DATA: path.join(temp, "aroz"),
  JOSHU_AROZ_USER: "owner",
  CUSTOMER_DOMAIN: BOX,
  TWILIO_THINK_PASSWORD: "harbor lantern",
  TWILIO_OWNER_CALLER: "+13105550100",
  HERMES_API_KEY: "svc-key",
});
await mkdir(path.join(temp, "aroz", "files", "users", "owner"), { recursive: true });

const { registerTelephoneRoutes } = await import("../src/telephoneSettings/routes.ts");
const { readTelephoneSettingsFile } = await import("../src/telephoneSettings/store.ts");

const servers = [];
async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

try {
  // Fake ArozOS: /system/auth/checkLogin answers true only for the good session cookie.
  const arozPort = await listen((req, res) => {
    const ok = req.url === "/system/auth/checkLogin" && req.headers.cookie === GOOD_COOKIE;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(ok));
  });
  process.env.PUBLIC_AROZ_PORT = String(arozPort);

  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerTelephoneRoutes(router, { projectRoot: process.cwd(), reconcileOnboarding: () => {} });
  app.use(router);
  const port = await listen(app);

  /** One request. `via: "caddy"` adds the headers that Caddy adds to a public request. */
  const call = (method, urlPath, { via = "caddy", cookie, body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const all =
        via === "caddy" ? { Host: BOX, "X-Forwarded-For": "203.0.113.9", "Sec-Fetch-Site": "same-origin" } : {};
      Object.assign(all, headers);
      if (cookie) all.Cookie = cookie;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload) all["Content-Type"] = "application/json";
      const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: all }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : undefined }),
        );
      });
      req.on("error", reject);
      req.end(payload);
    });

  // ---- No desktop session: 401, nothing read, nothing written ----
  for (const cookie of [undefined, "session-cookie=forged-session"]) {
    const read = await call("GET", "/api/telephone", { cookie });
    assert.equal(read.status, 401, `GET without a valid session (${cookie ?? "no cookie"})`);
    assert.equal(read.json.error, "desktop_session_required");
    assert.equal(read.text.includes("harbor lantern"), false);
    assert.equal(read.text.includes("+13105550100"), false);

    const write = await call("PUT", "/api/telephone", {
      cookie,
      body: { ownerCaller: "+13105550199", trustVerifiedCallerId: true, thinkPassword: "open sesame" },
    });
    assert.equal(write.status, 401, `PUT without a valid session (${cookie ?? "no cookie"})`);
    assert.deepEqual(readTelephoneSettingsFile(), {}, "an anonymous PUT writes nothing");

    const passphrase = await call("POST", "/api/telephone/passphrase", { cookie });
    assert.equal(passphrase.status, 401);
    assert.equal(passphrase.text.includes("harbor lantern"), false);
  }
  // A public request with a cookie but no same-origin fetch header (a link from another site).
  assert.equal(
    (await call("GET", "/api/telephone", { cookie: GOOD_COOKIE, headers: { "Sec-Fetch-Site": "cross-site" } })).status,
    401,
  );

  // ---- Desktop session: the Telephone app works, and the status holds no passphrase ----
  const read = await call("GET", "/api/telephone", { cookie: GOOD_COOKIE });
  assert.equal(read.status, 200);
  assert.equal(read.json.telephone.thinkPasswordConfigured, true);
  assert.equal(read.json.telephone.ownerCaller, "+13105550100");
  assert.equal("thinkPassword" in read.json.telephone, false);
  assert.equal(read.text.includes("harbor lantern"), false, "GET never returns the passphrase");

  const saved = await call("PUT", "/api/telephone", {
    cookie: GOOD_COOKIE,
    body: { thinkPassword: "copper meadow", trustVerifiedCallerId: true },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.telephone.trustVerifiedCallerId, true);
  assert.equal(saved.text.includes("copper meadow"), false, "PUT never returns the passphrase");
  assert.equal(readTelephoneSettingsFile().thinkPassword, "copper meadow");

  const shown = await call("POST", "/api/telephone/passphrase", { cookie: GOOD_COOKIE });
  assert.equal(shown.status, 200);
  assert.equal(shown.json.thinkPassword, "copper meadow");
  assert.equal(shown.headers["cache-control"], "no-store");

  // ---- Direct localhost (no proxy headers) keeps working, as for the other owner settings routes ----
  assert.equal((await call("GET", "/api/telephone", { via: "local" })).status, 200);

  // ---- Voice service route: its own service key, not the desktop session ----
  const fromCall = await call("POST", "/api/telephone/owner-mobile/from-call", {
    cookie: GOOD_COOKIE,
    body: { callSid: "CA-1", caller: "+13105550199" },
  });
  assert.equal(fromCall.status, 403, "a desktop session is not the voice service key");
  const fromVoice = await call("POST", "/api/telephone/owner-mobile/from-call", {
    via: "local",
    headers: { Authorization: "Bearer svc-key" },
    body: { callSid: "CA-1", caller: "+13105550199" },
  });
  assert.equal(fromVoice.status, 409, "the voice service reaches the route (owner mobile already set)");

  console.log("telephone auth: ok");
} finally {
  for (const server of servers) server.close();
}
