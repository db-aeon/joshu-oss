#!/usr/bin/env node
/**
 * ArozOS subservice entry for static apps.
 * ArozOS launches this script with -port :NNNN and proxies /<app>/* to /*.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticDir = path.resolve(__dirname, "..", "arozos", "subservice", "excalidraw", "app");
const staticDir = path.resolve(process.env.AROZ_STATIC_DIR ?? defaultStaticDir);
const appName = process.env.AROZ_STATIC_APP_NAME ?? "static-subservice";

function parseArgs(argv) {
  let port = ":8799";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-port" && argv[i + 1]) {
      port = argv[++i];
      continue;
    }
    if (arg === "-rpt" && argv[i + 1]) {
      i++;
    }
  }
  return { port };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".wasm":
      return "application/wasm";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const requested = path.resolve(staticDir, relative);

  if (!requested.startsWith(`${staticDir}${path.sep}`) && requested !== staticDir) {
    return undefined;
  }

  try {
    const stat = await fs.stat(requested);
    if (stat.isDirectory()) return path.join(requested, "index.html");
    if (stat.isFile()) return requested;
  } catch {
    // Fall through to SPA fallback below.
  }

  return path.join(staticDir, "index.html");
}

const { port } = parseArgs(process.argv.slice(2));
const listenPort = Number.parseInt(String(port).replace(/^:/, ""), 10);
if (!Number.isFinite(listenPort)) {
  console.error(`[${appName}] invalid -port:`, port);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    const filePath = await resolveRequestPath(req.url ?? "/");
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType(filePath),
    });
    res.end(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${appName}] failed to serve request: ${message}`);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`[${appName}] serving ${staticDir} on 127.0.0.1:${listenPort}`);
});
