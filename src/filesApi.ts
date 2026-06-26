import type { Request, Response, Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { resolveJoshuFilesPaths } from "./joshuFilesPaths.js";

function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const host = (req.hostname ?? "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost";
}

/** Resolve a user path under joshu's files; reject traversal. */
function resolveFilesPath(filesRoot: string, relativePath: string): string | null {
  const cleaned = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!cleaned || cleaned.includes("..")) return null;
  const abs = path.resolve(filesRoot, cleaned);
  const root = path.resolve(filesRoot);
  if (!abs.startsWith(`${root}${path.sep}`) && abs !== root) return null;
  return abs;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
    case ".excalidraw":
      return "application/json; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** Allow ArozOS subservices (e.g. jWhiteboard on :8787) to call Joshu files API on :8788. */
function setFilesApiCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  } catch {
    /* ignore bad Origin */
  }
}

export function registerFilesRoutes(router: Router): void {
  router.options("/api/files/context", (req, res) => {
    setFilesApiCors(req, res);
    res.status(204).end();
  });
  router.options("/api/files/read", (req, res) => {
    setFilesApiCors(req, res);
    res.status(204).end();
  });

  router.get("/api/files/context", (req, res) => {
    setFilesApiCors(req, res);
    const paths = resolveJoshuFilesPaths(process.cwd());
    if (!paths) {
      res.status(503).json({ error: "joshu files paths unavailable" });
      return;
    }
    res.json({
      filesRoot: paths.filesRoot,
      desktopRoot: paths.desktopRoot,
      arozUser: paths.arozUser,
      joshuFilesDirName: paths.joshuFilesDirName,
      arozPathPrefix: `user:/Desktop/${paths.joshuFilesDirName}`,
      linkScheme: "joshu://",
    });
  });

  router.get("/api/files/read", (req: Request, res: Response) => {
    setFilesApiCors(req, res);
    if (!isLocalhost(req)) {
      res.status(403).json({ error: "files/read is localhost-only" });
      return;
    }

    const paths = resolveJoshuFilesPaths(process.cwd());
    if (!paths) {
      res.status(503).json({ error: "joshu files paths unavailable" });
      return;
    }

    const rel = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!rel) {
      res.status(400).json({ error: "query path required" });
      return;
    }

    const abs = resolveFilesPath(paths.filesRoot, rel);
    if (!abs) {
      res.status(400).json({ error: "invalid path" });
      return;
    }

    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).json({ error: "file not found", path: rel });
      return;
    }

    const buf = fs.readFileSync(abs);
    res.setHeader("Content-Type", contentTypeFor(abs));
    res.setHeader("X-Joshu-Files-Path", rel);
    res.send(buf);
  });
}
