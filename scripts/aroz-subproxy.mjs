#!/usr/bin/env node
/**
 * ArozOS subservice entry: reverse-proxies HTTP/WebSocket to the Joshu Express app.
 * Invoked by subservice/joshu/start.sh with the same flags as the official Go demo:
 *   -info (unused when moduleInfo.json is present)
 *   -port :NNNN
 *   -rpt http://localhost:PARENT/api/ajgi/interface
 */
import http from "node:http";
import httpProxy from "http-proxy";

const upstream = process.env.JOSHU_UPSTREAM ?? "http://127.0.0.1:8788";
const upstreamBasePath = normalizeBasePath(process.env.JOSHU_UPSTREAM_BASE_PATH ?? "/joshu");

function normalizeBasePath(value) {
  const path = value.trim().replace(/\/+$/, "");
  if (!path || path === "/") return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function parseArgs(argv) {
  let port = ":8799";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-port" && argv[i + 1]) {
      port = argv[++i];
      continue;
    }
    if (a === "-rpt" && argv[i + 1]) {
      i++;
      continue;
    }
  }
  return { port };
}

const { port } = parseArgs(process.argv.slice(2));
const listenPort = Number.parseInt(String(port).replace(/^:/, ""), 10);
if (!Number.isFinite(listenPort)) {
  console.error("[joshu-aroz-proxy] invalid -port:", port);
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({
  target: upstream,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[joshu-aroz-proxy] proxy error:", err.message);
  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad gateway (Joshu upstream unreachable)");
  }
});

function addUpstreamBasePath(req) {
  if (!upstreamBasePath || !req.url) return;
  if (req.url === upstreamBasePath || req.url.startsWith(`${upstreamBasePath}/`)) return;
  const path = req.url.startsWith("/") ? req.url : `/${req.url}`;
  req.url = `${upstreamBasePath}${path}`;
}

const server = http.createServer((req, res) => {
  // ArozOS reverse-proxies /joshu/* to the subservice as /*. Joshu itself is
  // mounted at /joshu, so add that prefix back before forwarding upstream.
  addUpstreamBasePath(req);
  proxy.web(req, res, { target: upstream });
});

server.on("upgrade", (req, socket, head) => {
  addUpstreamBasePath(req);
  proxy.ws(req, socket, head, { target: upstream });
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`[joshu-aroz-proxy] listening 127.0.0.1:${listenPort} -> ${upstream}${upstreamBasePath}`);
});
