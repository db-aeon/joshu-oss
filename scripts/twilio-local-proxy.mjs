#!/usr/bin/env node
/**
 * Local reverse proxy so one ngrok tunnel can reach Joshu + voice-realtime.
 *
 *   /joshu/*     -> http://127.0.0.1:8788
 *   /voice-rt/*  -> http://127.0.0.1:8792  (OpenAI Realtime S2S)
 *
 * Usage: node scripts/twilio-local-proxy.mjs
 * Env: TWILIO_LOCAL_PROXY_PORT (default 8790)
 */

import http from "node:http";
import httpProxy from "http-proxy";

const PORT = Number(process.env.TWILIO_LOCAL_PROXY_PORT || "8790");
const HOST = process.env.TWILIO_LOCAL_PROXY_HOST || "127.0.0.1";

const ROUTES = [
  { prefix: "/joshu", target: process.env.JOSHU_PORT ? `http://127.0.0.1:${process.env.JOSHU_PORT}` : "http://127.0.0.1:8788" },
  {
    prefix: "/voice-rt",
    target: process.env.VOICE_REALTIME_PORT
      ? `http://127.0.0.1:${process.env.VOICE_REALTIME_PORT}`
      : "http://127.0.0.1:8792",
  },
];

function pickRoute(url = "/") {
  const path = url.split("?")[0] ?? "/";
  for (const route of ROUTES) {
    if (path === route.prefix || path.startsWith(`${route.prefix}/`)) {
      return route;
    }
  }
  return null;
}

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, req, res) => {
  console.error("[twilio-local-proxy]", err.message);
  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

/** Strip mount prefix so /voice-rt/health → upstream /health (matches Express proxy on Joshu). */
function rewriteUrlForUpstream(req, prefix) {
  const raw = req.url ?? "/";
  const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
  let pathOnly = raw.split("?")[0] ?? "/";
  if (prefix !== "/joshu" && (pathOnly === prefix || pathOnly.startsWith(`${prefix}/`))) {
    pathOnly = pathOnly.slice(prefix.length) || "/";
  }
  req.url = pathOnly + q;
}

const server = http.createServer((req, res) => {
  const route = pickRoute(req.url);
  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "No route",
        hint: "Use /joshu (webhook) or /voice-rt (OpenAI Realtime S2S)",
      }),
    );
    return;
  }
  rewriteUrlForUpstream(req, route.prefix);
  proxy.web(req, res, { target: route.target }, (err) => {
    if (err) console.error("[twilio-local-proxy]", err.message);
  });
});

server.on("upgrade", (req, socket, head) => {
  const route = pickRoute(req.url);
  if (!route) {
    socket.destroy();
    return;
  }
  rewriteUrlForUpstream(req, route.prefix);
  proxy.ws(req, socket, head, { target: route.target.replace(/^http/, "ws") });
});

server.listen(PORT, HOST, () => {
  console.log(`[twilio-local-proxy] http://${HOST}:${PORT}`);
  for (const r of ROUTES) {
    console.log(`  ${r.prefix}/* -> ${r.target}`);
  }
});
