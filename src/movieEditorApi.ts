import express, { type Request, type Response, type Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOVIE_EDITOR_DATA_DIR = path.join(ROOT_DIR, ".local", "movie-editor");
const PROJECTS_DIR = path.join(MOVIE_EDITOR_DATA_DIR, "projects");
const MEDIA_DIR = path.join(MOVIE_EDITOR_DATA_DIR, "media");

export type MovieProjectRecord = {
  id: string;
  title: string;
  type: "video" | "slide";
  source: Record<string, unknown>;
  updatedAt: string;
};

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function withPublicBase(urlPath: string): string {
  const base = envOr("PUBLIC_BASE_PATH", "").replace(/\/+$/, "");
  const p = (urlPath.startsWith("/") ? urlPath : `/${urlPath}`).replace(/\/+$/, "") || "/";
  if (!base) return p;
  if (p === base || p.startsWith(`${base}/`)) return p;
  return `${base}${p}`.replace(/\/+$/, "") || "/";
}

function sanitizeProjectId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/")) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]+/g, "_");
  return base.length > 0 ? base.slice(0, 200) : "upload.bin";
}

export function emptyMovieSource(type: "video" | "slide" = "video"): Record<string, unknown> {
  return {
    output_format: type === "slide" ? "jpg" : "mp4",
    width: 1280,
    height: 720,
    elements: [],
  };
}

function projectPath(id: string): string {
  return path.join(PROJECTS_DIR, `${id}.json`);
}

async function ensureDirs(): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
}

async function readProject(id: string): Promise<MovieProjectRecord | null> {
  try {
    const raw = await readFile(projectPath(id), "utf8");
    return JSON.parse(raw) as MovieProjectRecord;
  } catch {
    return null;
  }
}

async function writeProject(record: MovieProjectRecord): Promise<void> {
  await ensureDirs();
  await writeFile(projectPath(record.id), JSON.stringify(record, null, 2), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectHasElements(source: Record<string, unknown>): boolean {
  const elements = source.elements;
  return Array.isArray(elements) && elements.length > 0;
}

/** Load Creatomate JSON from MOVIE_EDITOR_DEFAULT_SOURCE (file path in .env). */
async function loadDefaultSourceFromEnv(): Promise<{ source: Record<string, unknown>; title: string } | null> {
  const sourcePath = envOr("MOVIE_EDITOR_DEFAULT_SOURCE", "");
  if (!sourcePath) return null;

  try {
    const raw = await readFile(sourcePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    const source = isRecord(parsed.source) ? parsed.source : parsed;
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : base.charAt(0).toUpperCase() + base.slice(1);

    return { source, title };
  } catch (error) {
    console.warn("[movie-editor] failed to read MOVIE_EDITOR_DEFAULT_SOURCE:", sourcePath, error);
    return null;
  }
}

async function ensureDefaultProject(): Promise<MovieProjectRecord> {
  const fromEnv = await loadDefaultSourceFromEnv();
  const existing = await readProject("default");

  if (existing) {
    // Reseed placeholder default when env points at a starter JSON file.
    if (fromEnv && !projectHasElements(existing.source)) {
      const updated: MovieProjectRecord = {
        ...existing,
        source: fromEnv.source,
        title: fromEnv.title,
        updatedAt: new Date().toISOString(),
      };
      await writeProject(updated);
      return updated;
    }
    return existing;
  }

  const created: MovieProjectRecord = {
    id: "default",
    title: fromEnv?.title ?? "Untitled project",
    type: "video",
    source: fromEnv?.source ?? emptyMovieSource("video"),
    updatedAt: new Date().toISOString(),
  };
  await writeProject(created);
  return created;
}

export function registerMovieEditorRoutes(router: Router): void {
  const mediaBase = withPublicBase("/media/movie");

  router.use(
    withPublicBase("/media/movie"),
    express.static(MEDIA_DIR, {
      etag: false,
      maxAge: 0,
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-store");
      },
    }),
  );

  router.get("/api/movie-editor/projects", async (_req: Request, res: Response) => {
    try {
      await ensureDirs();
      await ensureDefaultProject();
      const files = await readdir(PROJECTS_DIR);
      const projects: Array<{ id: string; title: string; type: string; updatedAt: string }> = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const id = file.replace(/\.json$/, "");
        const record = await readProject(id);
        if (!record) continue;
        projects.push({
          id: record.id,
          title: record.title,
          type: record.type,
          updatedAt: record.updatedAt,
        });
      }
      projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ projects });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/movie-editor/projects", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { title?: unknown; type?: unknown };
      const type = body.type === "slide" ? "slide" : "video";
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled project";
      const id = randomUUID().slice(0, 8);
      const record: MovieProjectRecord = {
        id,
        title,
        type,
        source: emptyMovieSource(type),
        updatedAt: new Date().toISOString(),
      };
      await writeProject(record);
      res.status(201).json({ project: { id: record.id, title: record.title, type: record.type, updatedAt: record.updatedAt } });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/movie-editor/projects/:id", async (req: Request, res: Response) => {
    const id = sanitizeProjectId(String(req.params.id ?? ""));
    if (!id) return res.status(400).json({ error: "Invalid project id" });

    try {
      let record = await readProject(id);
      if (!record && id === "default") record = await ensureDefaultProject();
      if (!record) return res.status(404).json({ error: "Project not found" });

      res.json({
        directive: {
          id: record.id,
          title: record.title,
          type: record.type,
          filename: `${record.id}.json`,
        },
        source: record.source,
        assets: [],
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put("/api/movie-editor/projects/:id", async (req: Request, res: Response) => {
    const id = sanitizeProjectId(String(req.params.id ?? ""));
    if (!id) return res.status(400).json({ error: "Invalid project id" });

    const body = (req.body ?? {}) as { source?: unknown; title?: unknown };
    if (!body.source || typeof body.source !== "object" || Array.isArray(body.source)) {
      return res.status(400).json({ error: "Expected JSON body with source object" });
    }

    try {
      let record = await readProject(id);
      if (!record && id === "default") record = await ensureDefaultProject();
      if (!record) return res.status(404).json({ error: "Project not found" });

      record = {
        ...record,
        source: body.source as Record<string, unknown>,
        title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : record.title,
        updatedAt: new Date().toISOString(),
      };
      await writeProject(record);

      res.json({
        directive: {
          id: record.id,
          title: record.title,
          type: record.type,
          filename: `${record.id}.json`,
        },
        source: record.source,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/api/movie-editor/projects/:id", async (req: Request, res: Response) => {
    const id = sanitizeProjectId(String(req.params.id ?? ""));
    if (!id) return res.status(400).json({ error: "Invalid project id" });
    if (id === "default") return res.status(400).json({ error: "Cannot delete the default project" });

    try {
      await rm(projectPath(id), { force: true });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post(
    "/api/movie-editor/upload",
    express.raw({ limit: "100mb", type: () => true }),
    async (req: Request, res: Response) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: "Expected raw file body" });
      }

      const rawName = req.headers["x-filename"];
      const filename = sanitizeFilename(typeof rawName === "string" ? rawName : "upload.bin");
      const storedName = `${randomUUID().slice(0, 8)}-${filename}`;

      try {
        await ensureDirs();
        await writeFile(path.join(MEDIA_DIR, storedName), body);
        const url = `${mediaBase}/${storedName}`;
        res.json({ url, filename: storedName });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );
}
