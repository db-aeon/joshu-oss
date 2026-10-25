/**
 * Launch one headed Chromium with Decodo (PROXY_*) and expose CDP.
 *
 * Authenticated upstream proxies need a local forwarding hop: Playwright's
 * proxy username/password only cover Playwright-initiated traffic, while Hermes
 * and Joshu attach via raw CDP. Chrome gets --proxy-server without credentials,
 * so we inject Proxy-Authorization on a localhost proxy first.
 *
 * A failed CONNECT rotates to the next PROXY_PORTS entry inside the local
 * proxy. Chromium stays on 127.0.0.1:8877, so the tab is not restarted.
 * POST /rotate-proxy advances the port. It relaunches Chromium only when the
 * port is baked into the browser process (no local auth proxy).
 */
import http from "node:http";
import net from "node:net";
import { chromium } from "playwright-core";
import { basicAuthHeader, createAuthInjectProxy } from "./localProxy.mjs";

/** Port Docker publishes. Chrome 136+ ignores --remote-debugging-address and binds 127.0.0.1 only. */
const CDP_PORT = Number(process.env.CDP_PORT || "9222");
/** Real DevTools port. A TCP proxy on CDP_PORT forwards 0.0.0.0 to this localhost socket. */
const CHROME_CDP_PORT = Number(process.env.CHROME_CDP_PORT || String(CDP_PORT + 1));
const HEALTH_PORT = Number(process.env.BROWSER_HEALTH_PORT || "9377");
const LOCAL_PROXY_PORT = Number(process.env.BROWSER_LOCAL_PROXY_PORT || "8877");
const WIDTH = Number(process.env.CAMOFOX_VIEWPORT_WIDTH || process.env.BROWSER_VIEWPORT_WIDTH || "1024");
const HEIGHT = Number(process.env.CAMOFOX_VIEWPORT_HEIGHT || process.env.BROWSER_VIEWPORT_HEIGHT || "768");
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || "/usr/bin/chromium";

function proxyHost() {
  return (process.env.PROXY_BACKCONNECT_HOST || process.env.PROXY_HOST || "").trim();
}

/** Same port list as src/proxyConfig.ts listProxyPorts (no explicit HTTPS_PROXY override). */
function listProxyPorts() {
  const host = proxyHost();
  if (!host) return [];
  const back = (process.env.PROXY_BACKCONNECT_PORT || "").trim();
  if (back) return [Number(back)];
  const single = (process.env.PROXY_PORT || "").trim();
  if (single) return [Number(single)];
  const ports = (process.env.PROXY_PORTS || "").trim();
  if (!ports) return [8080];
  if (ports.includes("-")) {
    const [rawLo, rawHi] = ports.split("-", 2);
    const lo = Number(rawLo);
    const hi = Number(rawHi);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const min = Math.min(lo, hi);
      const max = Math.max(lo, hi);
      return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }
  }
  return ports
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isFinite(port));
}

const ports = listProxyPorts();
let portIndex = 0;
let browser = null;
let launching = null;
/** @type {{ url: string, close: () => Promise<void> } | null} */
let localProxy = null;

function currentPort() {
  if (ports.length === 0) return null;
  return ports[portIndex % ports.length];
}

/** Move to the next Decodo port. Safe to call from a CONNECT failure. */
function rotateUpstream(reason) {
  if (ports.length < 2) return currentPort();
  const failed = currentPort();
  portIndex += 1;
  console.warn(`[chromium] upstream port ${failed} failed (${reason}) — now ${currentPort()}`);
  return currentPort();
}

function upstreamProxyTarget() {
  const host = proxyHost();
  const port = currentPort();
  if (!host || port == null) return null;
  return { host, port };
}

function proxyAuthHeader() {
  const username = (process.env.PROXY_USERNAME || "").trim();
  if (!username) return "";
  return basicAuthHeader(username, process.env.PROXY_PASSWORD || "");
}

function needsLocalAuthProxy() {
  return Boolean(upstreamProxyTarget() && proxyAuthHeader());
}

/** Skip Decodo ports that return 502 on CONNECT (common in the 10001-10010 pool). */
function probeUpstreamPort(host, port) {
  return new Promise((resolve) => {
    const auth = proxyAuthHeader();
    const socket = net.connect(port, host, () => {
      let headers = "CONNECT probe.example:443 HTTP/1.1\r\nHost: probe.example:443\r\n";
      if (auth) headers += `Proxy-Authorization: ${auth}\r\n`;
      headers += "\r\n";
      socket.write(headers);
    });
    let buf = "";
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(8000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n")) return;
      finish(/^HTTP\/1\.[01] 200/i.test(buf.split("\r\n")[0] || ""));
    });
  });
}

async function pickHealthyUpstreamPort() {
  if (ports.length === 0) return;
  const host = proxyHost();
  if (!host) return;
  for (let attempt = 0; attempt < ports.length; attempt += 1) {
    const port = currentPort();
    if (port != null && (await probeUpstreamPort(host, port))) {
      console.log(`[chromium] upstream port ${port} healthy`);
      return;
    }
    console.warn(`[chromium] upstream port ${port} unhealthy — rotating`);
    portIndex += 1;
  }
  console.warn("[chromium] no healthy upstream port found; launching anyway");
}

/** Proxy object for chromium.launch — always without Playwright-side credentials. */
function chromiumProxy() {
  if (!upstreamProxyTarget()) return undefined;
  if (needsLocalAuthProxy()) {
    return { server: `http://127.0.0.1:${LOCAL_PROXY_PORT}` };
  }
  const up = upstreamProxyTarget();
  return { server: `http://${up.host}:${up.port}` };
}

async function ensureLocalAuthProxy() {
  if (!needsLocalAuthProxy()) {
    if (localProxy) {
      await localProxy.close();
      localProxy = null;
    }
    return;
  }
  if (localProxy) return;
  localProxy = await createAuthInjectProxy({
    listenHost: "127.0.0.1",
    listenPort: LOCAL_PROXY_PORT,
    getUpstream: upstreamProxyTarget,
    getAuthHeader: proxyAuthHeader,
    maxAttempts: Math.max(1, ports.length),
    onUpstreamFailure: (upstream, reason) => {
      // Another in-flight CONNECT may already have moved off this port.
      if (currentPort() === upstream.port) rotateUpstream(reason);
    },
  });
  console.log(
    `[chromium] local auth proxy ${localProxy.url} -> ${proxyHost()}:${currentPort()}`,
  );
}

async function launchBrowser() {
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
  await pickHealthyUpstreamPort();
  await ensureLocalAuthProxy();
  const proxy = chromiumProxy();
  console.log(
    `[chromium] launch port=${currentPort() ?? "direct"} proxy=${proxy ? proxy.server : "off"}`,
  );
  // cdpPort makes Playwright use a TCP debug port instead of a private pipe.
  // The published port is the proxy below; Chrome itself stays on localhost.
  browser = await chromium.launch({
    executablePath: CHROMIUM_BIN,
    headless: false,
    proxy,
    cdpPort: CHROME_CDP_PORT,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-allow-origins=*",
      "--lang=en-US",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=0,0",
      `--window-size=${WIDTH},${HEIGHT}`,
    ],
  });
  browser.on("disconnected", () => {
    browser = null;
  });
}

function launchSerialized() {
  if (!launching) {
    launching = launchBrowser().finally(() => {
      launching = null;
    });
  }
  return launching;
}

/** Hermes/Joshu attach via raw CDP — those tabs are not Playwright context pages. */
async function cdpPageTabCount() {
  try {
    const res = await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return 0;
    const targets = await res.json();
    if (!Array.isArray(targets)) return 0;
    return targets.filter(
      (target) =>
        target?.type === "page" && !String(target.url || "").startsWith("chrome://"),
    ).length;
  } catch {
    return 0;
  }
}

async function activeTabCount() {
  if (!browser || !browser.isConnected()) return 0;
  try {
    const contexts = browser.contexts();
    const playwrightPages = contexts.reduce((sum, context) => sum + context.pages().length, 0);
    if (playwrightPages > 0) return playwrightPages;
  } catch {
    // fall through — count CDP targets instead.
  }
  return cdpPageTabCount();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    const running = Boolean(browser && browser.isConnected());
    const body = {
      ok: running,
      engine: "chromium",
      browserRunning: running,
      browserConnected: running,
      activeTabs: await activeTabCount(),
      proxyPort: currentPort(),
      localProxyPort: localProxy ? LOCAL_PROXY_PORT : null,
    };
    res.writeHead(running ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/rotate-proxy") {
    if (ports.length === 0) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "no_proxy" }));
      return;
    }
    const failed = currentPort();
    portIndex += 1;
    // The local proxy reads the port on each CONNECT. Relaunching would drop
    // the live tab, so only do that when Chrome itself has the upstream address.
    const relaunch = !localProxy;
    try {
      if (relaunch) await launchSerialized();
      else console.warn(`[chromium] rotate-proxy ${failed} -> ${currentPort()} (no relaunch)`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, proxyPort: currentPort(), relaunched: relaunch }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

function pipeSockets(left, right) {
  const closeBoth = () => {
    left.destroy();
    right.destroy();
  };
  left.on("error", closeBoth);
  right.on("error", closeBoth);
  left.on("end", () => right.end());
  right.on("end", () => left.end());
  left.pipe(right);
  right.pipe(left);
}

// Docker publishes CDP_PORT onto the container's eth0. Chrome will not listen there.
net
  .createServer((socket) => {
    const upstream = net.connect(CHROME_CDP_PORT, "127.0.0.1");
    upstream.on("error", () => socket.destroy());
    pipeSockets(socket, upstream);
  })
  .listen(CDP_PORT, "0.0.0.0", () => {
    console.log(`[chromium] cdp proxy 0.0.0.0:${CDP_PORT} -> 127.0.0.1:${CHROME_CDP_PORT}`);
  });

server.listen(HEALTH_PORT, "0.0.0.0", () => {
  console.log(`[chromium] health http://127.0.0.1:${HEALTH_PORT}/health`);
});

const TUNNEL_PAGE_RE =
  /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|can.?t be reached|proxy server is refusing/i;
/** Avoid reloading the same broken tab forever. */
const tunnelReloads = new Map();

function cdpCall(wsUrl, method, params = {}) {
  const WS = globalThis.WebSocket;
  if (!WS || !wsUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WS(wsUrl);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      resolve(null);
    }, 8000);
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(msg.result ?? null);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  });
}

/** If a tab is already the Chrome tunnel error, move ports and reload it. */
async function recoverTunnelErrorTabs() {
  if (!browser?.isConnected() || typeof globalThis.WebSocket !== "function") return;
  let targets = [];
  try {
    const res = await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    targets = await res.json();
  } catch {
    return;
  }
  if (!Array.isArray(targets)) return;
  for (const target of targets) {
    if (target?.type !== "page" || !String(target.url || "").startsWith("chrome-error://")) continue;
    const id = String(target.id || "");
    const tries = tunnelReloads.get(id) || 0;
    if (tries >= 3) continue;
    const evaluated = await cdpCall(target.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: "document.body ? document.body.innerText.slice(0, 500) : ''",
      returnByValue: true,
    });
    const text = evaluated?.result?.value || "";
    if (!TUNNEL_PAGE_RE.test(text)) continue;
    tunnelReloads.set(id, tries + 1);
    console.warn(`[chromium] tunnel error tab — reload via next Decodo port (${tries + 1}/3)`);
    rotateUpstream("tunnel error page");
    await cdpCall(target.webSocketDebuggerUrl, "Page.reload", { ignoreCache: true });
  }
}

setInterval(() => {
  recoverTunnelErrorTabs().catch((err) => {
    console.warn("[chromium] tunnel recovery failed:", err instanceof Error ? err.message : err);
  });
}, 10_000);

launchSerialized().catch((err) => {
  console.error("[chromium] initial launch failed:", err);
  process.exit(1);
});
