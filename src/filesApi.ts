import type { Request, Response, Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { isDesktopBrowserOrLocalRequest } from "./httpLocalhost.js";
import { resolveJoshuFilesPaths } from "./joshuFilesPaths.js";

function isLocalhost(req: Request): boolean {
  return isDesktopBrowserOrLocalRequest(req);
}

/** Resolve a user path under a root; reject traversal. */
function resolveUnderRoot(rootDir: string, relativePath: string): string | null {
  const cleaned = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!cleaned || cleaned.includes("..")) return null;
  const abs = path.resolve(rootDir, cleaned);
  const root = path.resolve(rootDir);
  if (!abs.startsWith(`${root}${path.sep}`) && abs !== root) return null;
  return abs;
}

type PathRoot = "files" | "desktop";

function resolveReadWriteTarget(
  paths: NonNullable<ReturnType<typeof resolveJoshuFilesPaths>>,
  rel: string,
  root: PathRoot,
): { abs: string; rel: string; root: PathRoot } | null {
  const base = root === "desktop" ? paths.desktopRoot : paths.filesRoot;
  const abs = resolveUnderRoot(base, rel);
  if (!abs) return null;
  return { abs, rel: rel.replace(/^\/+/, "").replace(/\\/g, "/"), root };
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
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");
    }
  } catch {
    /* ignore bad Origin */
  }
}

function parseRoot(raw: unknown): PathRoot {
  return raw === "desktop" ? "desktop" : "files";
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
  router.options("/api/files/write", (req, res) => {
    setFilesApiCors(req, res);
    res.status(204).end();
  });

  router.get("/api/files/context", (req, res) => {
    setFilesApiCors(req, res);
    if (!isLocalhost(req)) {
      res.status(403).json({ error: "files/context is desktop-session-only" });
      return;
    }
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
      arozDesktopPrefix: "user:/Desktop",
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

    const root = parseRoot(req.query.root);
    const target = resolveReadWriteTarget(paths, rel, root);
    if (!target) {
      res.status(400).json({ error: "invalid path" });
      return;
    }

    if (!fs.existsSync(target.abs) || !fs.statSync(target.abs).isFile()) {
      res.status(404).json({ error: "file not found", path: target.rel, root: target.root });
      return;
    }

    const buf = fs.readFileSync(target.abs);
    res.setHeader("Content-Type", contentTypeFor(target.abs));
    res.setHeader("X-Joshu-Files-Path", target.rel);
    res.setHeader("X-Joshu-Files-Root", target.root);
    res.send(buf);
  });

  /**
   * Write UTF-8 text under joshu's files (default) or the ArozOS Desktop tree.
   * Used by jNotes (Milkdown) so agents and the UI can persist markdown without
   * going through ArozOS AGI filelib.
   */
  router.post("/api/files/write", (req: Request, res: Response) => {
    setFilesApiCors(req, res);
    if (!isLocalhost(req)) {
      res.status(403).json({ error: "files/write is localhost-only" });
      return;
    }

    const paths = resolveJoshuFilesPaths(process.cwd());
    if (!paths) {
      res.status(503).json({ error: "joshu files paths unavailable" });
      return;
    }

    const body = (req.body ?? {}) as { path?: unknown; content?: unknown; root?: unknown };
    const rel = typeof body.path === "string" ? body.path.trim() : "";
    if (!rel) {
      res.status(400).json({ error: "body.path required" });
      return;
    }
    if (typeof body.content !== "string") {
      res.status(400).json({ error: "body.content string required" });
      return;
    }

    const root = parseRoot(body.root);
    const target = resolveReadWriteTarget(paths, rel, root);
    if (!target) {
      res.status(400).json({ error: "invalid path" });
      return;
    }

    // Only allow writing text-ish documents from the markdown editor path.
    const ext = path.extname(target.abs).toLowerCase();
    if (![".md", ".markdown", ".txt", ".mdx"].includes(ext)) {
      res.status(400).json({ error: "files/write only allows .md/.markdown/.txt/.mdx" });
      return;
    }

    try {
      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, body.content, "utf8");
      res.json({ ok: true, path: target.rel, root: target.root, bytes: Buffer.byteLength(body.content, "utf8") });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "write failed",
        path: target.rel,
        root: target.root,
      });
    }
  });
}
