/**
 * Joshu file-brain read API — proxies gbrain CLI search/query (read lane).
 * File writes use Hermes filesystem tools; indexing is automatic via gbrain MCP proxy.
 * See docs/file-brain.md
 */

import { execFile as execFileCb } from "node:child_process";
import type { NextFunction, Request, Response, Router } from "express";
import { appendFileSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  formatGbrainCliError,
  gbrainMcpGetPage,
  gbrainMcpList,
  gbrainMcpQuery,
  gbrainMcpSearch,
  fetchGbrainMcpTotalPages,
  fetchGbrainMcpHealthStatus,
  probeGbrainMcpInspect,
} from "./gbrainMcpInspect.js";
import { gbrainIndexedOk } from "./gbrainIndexCoverage.js";
import { resolveJoshuFilesPaths } from "./joshuFilesPaths.js";

const execFile = promisify(execFileCb);

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function defaultGbrainHome(): string {
  const fromEnv = envTrim("GBRAIN_HOME");
  if (fromEnv) return path.resolve(fromEnv);
  const local = path.join(process.cwd(), ".local", "gbrain");
  return local;
}

function readApiKey(): string {
  return envTrim("JOSHU_READ_API_KEY");
}

/** Require Bearer token when JOSHU_READ_API_KEY is set. */
export function requireReadApiAuth(req: Request, res: Response, next: NextFunction): void {
  const key = readApiKey();
  if (!key) {
    next();
    return;
  }
  const auth = req.headers.authorization;
  const voiceCallSid = typeof req.headers["x-voice-call-sid"] === "string"
    ? req.headers["x-voice-call-sid"]
    : undefined;
  if (auth === `Bearer ${key}`) {
    next();
    return;
  }
  console.warn(
    `[brain-api] 401 ${req.method} ${req.path} voice=${voiceCallSid ?? "-"} auth=${auth ? `Bearer…(${auth.length - 7} chars)` : "missing"}`,
  );
  res.status(401).json({ error: "Unauthorized" });
}

/** gbrain CLI text lines: `[0.79] slug -- snippet` */
export type BrainSearchHit = { score: number; slug: string; snippet: string };

export function parseGbrainSearchStdout(stdout: string): BrainSearchHit[] {
  const hits: BrainSearchHit[] = [];
  const lineRe = /^\[([\d.]+)\]\s+(\S+)\s+--\s+(.*)$/;
  let current: BrainSearchHit | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (m) {
      if (current) hits.push(current);
      current = {
        score: Number(m[1]),
        slug: m[2]!,
        snippet: m[3]!.trim(),
      };
      continue;
    }
    if (current && line.trim()) {
      current.snippet += `\n${line}`;
    }
  }
  if (current) hits.push(current);
  return hits;
}

/** gbrain list TSV: slug, type, date, title */
export type BrainPageListItem = { slug: string; type: string; date: string; title: string };

export function parseGbrainListStdout(stdout: string): BrainPageListItem[] {
  const pages: BrainPageListItem[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || /^Pack:/i.test(trimmed)) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    pages.push({
      slug: parts[0]!.trim(),
      type: parts[1]?.trim() ?? "",
      date: parts[2]?.trim() ?? "",
      title: parts.slice(3).join("\t").trim() || parts[0]!.trim(),
    });
  }
  return pages;
}

/** Parse gbrain list output — MCP JSON array or CLI TSV. */
export function parseGbrainListResponse(stdout: string): BrainPageListItem[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
          ? ((parsed as { pages?: unknown[] }).pages ?? (parsed as { items?: unknown[] }).items ?? [])
          : [];
      if (Array.isArray(rows) && rows.length > 0) {
        const pages: BrainPageListItem[] = [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          const slug = typeof r.slug === "string" ? r.slug.trim() : "";
          if (!slug) continue;
          const updated =
            typeof r.date === "string"
              ? r.date
              : typeof r.updated_at === "string"
                ? r.updated_at
                : typeof r.updated === "string"
                  ? r.updated
                  : "";
          pages.push({
            slug,
            type: typeof r.type === "string" ? r.type : "",
            date: updated.slice(0, 10),
            title: typeof r.title === "string" ? r.title : slug,
            ...(typeof r.source_id === "string" ? { source_id: r.source_id } : {}),
          });
        }
        return pages;
      }
    } catch {
      /* fall through to TSV */
    }
  }

  return parseGbrainListStdout(stdout);
}

function parseSchemaStatsTotalPages(stdout: string): number | null {
  const match = stdout.match(/^Total pages:\s*(\d+)/im);
  return match ? Number(match[1]) : null;
}

function parseDoctorJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeSearchHits(rows: unknown[]): BrainSearchHit[] {
  const hits: BrainSearchHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? r.slug.trim() : "";
    if (!slug) continue;
    const snippetRaw =
      typeof r.snippet === "string"
        ? r.snippet
        : typeof r.chunk_text === "string"
          ? r.chunk_text
          : typeof r.text === "string"
            ? r.text
            : "";
    const snippet = snippetRaw.trim();
    const score =
      typeof r.score === "number"
        ? r.score
        : typeof r.base_score === "number"
          ? r.base_score
          : 0;
    hits.push({
      slug,
      snippet: snippet || "(no snippet)",
      score,
    });
  }
  return hits;
}

function formatSearchResponse(query: string, stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed || /^no results\.?$/i.test(trimmed)) {
    return {
      query,
      hit_count: 0,
      hits: [],
      summary: "No matching files found in the brain index.",
      hint: "Try brain_search with concrete keywords from the user's topic (names, dates like 2026-05-24, project names) rather than meta phrases like 'journal entry from yesterday'.",
    };
  }

  let parsed: unknown = trimmed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
  }

  if (Array.isArray(parsed)) {
    const hits = normalizeSearchHits(parsed);
    return { query, hit_count: hits.length, hits };
  }

  const hits = parseGbrainSearchStdout(trimmed);
  if (hits.length > 0) {
    return {
      query,
      hit_count: hits.length,
      hits,
      summary: hits
        .slice(0, 3)
        .map((h) => `${h.slug}: ${h.snippet.split("\n")[0]?.slice(0, 200) ?? ""}`)
        .join(" | "),
    };
  }

  return { query, hit_count: 0, hits: [], raw: trimmed };
}

async function runGbrain(
  args: string[],
  timeoutMs = 15_000,
  maxAttempts = 3,
): Promise<{ stdout: string; stderr: string }> {
  const bin = envTrim("GBRAIN_BIN", "gbrain");
  const paths = resolveJoshuFilesPaths();
  const env = {
    ...process.env,
    PATH: `${process.env.HOME ?? ""}/.bun/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
    GBRAIN_HOME: defaultGbrainHome(),
    GBRAIN_SOURCE: envTrim("GBRAIN_SOURCE", "default"),
    ...(paths ? { JOSHU_FILES_ROOT: paths.filesRoot, JOSHU_DESKTOP_ROOT: paths.desktopRoot } : {}),
  };
  delete (env as Record<string, string | undefined>).DATABASE_URL;
  delete (env as Record<string, string | undefined>).GBRAIN_DATABASE_URL;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { stdout, stderr } = await execFile(bin, args, {
        env,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts - 1 && /pglite lock|timed out waiting for/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      if (/pglite lock|timed out waiting for/i.test(msg)) {
        throw new Error(formatGbrainCliError(err));
      }
      throw err;
    }
  }
  throw lastErr;
}

type GbrainLane = "gbrain-cli" | "gbrain-mcp-http";

let gbrainMcpStartInFlight: Promise<void> | null = null;

/** File Brain browse uses MCP get_recent_salience; start :8794 if vps-start left it down. */
async function ensureGbrainMcpHttp(): Promise<void> {
  if (await probeGbrainMcpInspect()) return;

  if (!gbrainMcpStartInFlight) {
    const appDir = envTrim("APP_DIR") || process.cwd();
    const script = path.join(appDir, "scripts", "start-gbrain-mcp-http.sh");
    gbrainMcpStartInFlight = execFile("bash", [script], {
      env: process.env,
      timeout: 180_000,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        gbrainMcpStartInFlight = null;
      });
  }
  await gbrainMcpStartInFlight;

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await probeGbrainMcpInspect()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function resolveGbrainLane(): Promise<GbrainLane> {
  await ensureGbrainMcpHttp();
  return (await probeGbrainMcpInspect()) ? "gbrain-mcp-http" : "gbrain-cli";
}

async function withGbrainLane<T>(
  cliFn: () => Promise<T>,
  mcpFn: () => Promise<T>,
): Promise<{ lane: GbrainLane; value: T }> {
  if (await probeGbrainMcpInspect()) {
    try {
      return { lane: "gbrain-mcp-http", value: await mcpFn() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`gbrain MCP HTTP: ${msg}`);
    }
  }
  try {
    return { lane: "gbrain-cli", value: await cliFn() };
  } catch (err) {
    throw new Error(formatGbrainCliError(err));
  }
}

/** Touch file watched by gbrain MCP HTTP server to queue debounced sync_brain. */
export function requestBrainReindex(): { ok: true; touchPath: string } | { ok: false; error: string } {
  const gbrainHome = defaultGbrainHome();
  const touchPath = path.join(gbrainHome, ".joshu-reindex-touch");
  const now = new Date();
  try {
    mkdirSync(gbrainHome, { recursive: true });
    appendFileSync(touchPath, "", { flag: "a" });
    utimesSync(touchPath, now, now);
    return { ok: true, touchPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function mountBrainHandlers(router: Router, prefix: string): void {
  router.get(`${prefix}/health`, async (_req: Request, res: Response) => {
    try {
      await runGbrain(["doctor"], 15_000);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(503).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get(`${prefix}/status`, async (_req: Request, res: Response) => {
    const paths = resolveJoshuFilesPaths();
    const gbrainHome = defaultGbrainHome();
    const lane = await resolveGbrainLane();
    const basePaths = paths
      ? {
          arozData: paths.arozData,
          desktopRoot: paths.desktopRoot,
          filesRoot: paths.filesRoot,
          arozUser: paths.arozUser,
          gbrainHome,
        }
      : { gbrainHome };

    if (lane === "gbrain-mcp-http") {
      const totalPages = await fetchGbrainMcpTotalPages();
      return res.json({
        ok: true,
        lane,
        mcp_inspect: true,
        paths: basePaths,
        schema: { total_pages: totalPages },
        hint: "Reading gbrain via MCP inspect lane (same PGLite holder as Hermes).",
      });
    }

    try {
      const [doctorOut, schemaOut] = await Promise.all([
        runGbrain(["doctor", "--json", "--fast"], 15_000),
        runGbrain(["schema", "stats"], 10_000).catch(() => ({ stdout: "", stderr: "" })),
      ]);
      const doctor = parseDoctorJson(doctorOut.stdout);
      const totalPages = parseSchemaStatsTotalPages(schemaOut.stdout);
      const healthScore =
        typeof doctor?.health_score === "number" ? doctor.health_score : null;
      const status = typeof doctor?.status === "string" ? doctor.status : null;
      return res.json({
        ok: true,
        health_score: healthScore,
        status,
        lane,
        doctor,
        paths: basePaths,
        schema: {
          raw: schemaOut.stdout.trim(),
          total_pages: totalPages,
        },
      });
    } catch (err) {
      return res.status(503).json({
        ok: false,
        lane,
        paths: basePaths,
        error: formatGbrainCliError(err),
      });
    }
  });

  router.get(`${prefix}/pages`, async (req: Request, res: Response) => {
    const limit = Number.parseInt(typeof req.query.limit === "string" ? req.query.limit : "50", 10) || 50;
    const type = typeof req.query.type === "string" ? req.query.type.trim() : "";
    const sort = typeof req.query.sort === "string" ? req.query.sort.trim() : "updated_desc";
    const args = ["list", "--limit", String(limit), "--sort", sort];
    if (type) args.push("--type", type);
    try {
      const { lane, value: stdout } = await withGbrainLane(
        async () => {
          const { stdout: out } = await runGbrain(args, 15_000);
          return out;
        },
        async () => gbrainMcpList({ limit, type, sort }),
      );
      const pages = parseGbrainListResponse(stdout);
      return res.json({ page_count: pages.length, pages, lane });
    } catch (err) {
      return res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get(`${prefix}/pages/:slug`, async (req: Request, res: Response) => {
    const slug = decodeURIComponent(String(req.params.slug ?? "")).trim();
    if (!slug) {
      return res.status(400).json({ error: "Missing page slug" });
    }
    try {
      const { lane, value: stdout } = await withGbrainLane(
        async () => {
          const { stdout: out } = await runGbrain(["get", slug], 15_000);
          return out;
        },
        async () => gbrainMcpGetPage(slug),
      );
      const content = stdout.trim();
      if (!content || /^page not found/i.test(content)) {
        return res.status(404).json({ error: "Page not found", slug });
      }
      return res.json({ slug, content, lane });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|unknown page/i.test(msg)) {
        return res.status(404).json({ error: "Page not found", slug });
      }
      return res.status(502).json({ error: msg });
    }
  });

  router.post(`${prefix}/reindex`, async (_req: Request, res: Response) => {
    const result = requestBrainReindex();
    if (!result.ok) {
      return res.status(503).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, touchPath: result.touchPath, message: "Reindex scheduled (debounced sync_brain via MCP proxy)" });
  });

  router.get(`${prefix}/search`, async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return res.status(400).json({ error: "Missing query parameter q" });
    }
    const limit = typeof req.query.limit === "string" ? req.query.limit : "10";
    const voiceCallSid = typeof req.headers["x-voice-call-sid"] === "string"
      ? req.headers["x-voice-call-sid"]
      : undefined;
    const t0 = performance.now();
    try {
      const { lane, value: stdout } = await withGbrainLane(
        async () => {
          const { stdout: out } = await runGbrain(["search", q, "--limit", limit, "--json"], 15_000);
          return out;
        },
        async () => gbrainMcpSearch(q, Number.parseInt(limit, 10) || 10),
      );
      const body = formatSearchResponse(q, stdout);
      const ms = Math.round(performance.now() - t0);
      console.info(
        `[brain-api] search q=${JSON.stringify(q)} hits=${body.hit_count ?? 0} lane=${lane} ms=${ms}${voiceCallSid ? ` voice=${voiceCallSid}` : ""}`,
      );
      return res.json({ ...body, lane });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[brain-api] search failed q=${JSON.stringify(q)} ms=${ms}${voiceCallSid ? ` voice=${voiceCallSid}` : ""}: ${msg}`,
      );
      return res.status(502).json({ error: msg });
    }
  });

  router.get(`${prefix}/query`, async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return res.status(400).json({ error: "Missing query parameter q" });
    }
    const voiceCallSid = typeof req.headers["x-voice-call-sid"] === "string"
      ? req.headers["x-voice-call-sid"]
      : undefined;
    const t0 = performance.now();
    try {
      const { lane, value: stdout } = await withGbrainLane(
        async () => {
          const { stdout: out } = await runGbrain(["query", q, "--source-id", "__all__"], 15_000);
          return out;
        },
        async () => gbrainMcpQuery(q, 20),
      );
      const answer = stdout.trim();
      const empty = !answer || /^no results\.?$/i.test(answer);
      const body = {
        query: q,
        answer: empty ? "No matching content found in indexed files." : answer,
        hit_count: empty ? 0 : 1,
        lane,
      };
      const ms = Math.round(performance.now() - t0);
      console.info(
        `[brain-api] query q=${JSON.stringify(q)} hit_count=${body.hit_count} lane=${lane} ms=${ms}${voiceCallSid ? ` voice=${voiceCallSid}` : ""}`,
      );
      return res.json(body);
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[brain-api] query failed q=${JSON.stringify(q)} ms=${ms}${voiceCallSid ? ` voice=${voiceCallSid}` : ""}: ${msg}`,
      );
      return res.status(502).json({ error: msg });
    }
  });
}

export function registerBrainRoutes(router: Router): void {
  // Unauthenticated bootstrap for File Brain viewer (returns key only when read lane is gated).
  router.get("/api/brain/viewer-config", (_req: Request, res: Response) => {
    const key = readApiKey();
    res.json({ readApiKey: key || null });
  });

  router.use("/api/brain", requireReadApiAuth);
  mountBrainHandlers(router, "/api/brain");

  router.use("/api/read/brain", requireReadApiAuth);
  mountBrainHandlers(router, "/api/read/brain");
}

export async function probeGbrainHealth(): Promise<{
  ok: boolean;
  indexed_ok?: boolean;
  page_count?: number;
  disk_markdown?: number;
}> {
  const paths = resolveJoshuFilesPaths();
  const mcp = await fetchGbrainMcpHealthStatus(2_000);

  // MCP HTTP up — do not fall through to gbrain CLI (PGLite lock while serve runs).
  if (mcp.reachable && mcp.ok) {
    if (!mcp.sessionReady) {
      return { ok: true };
    }
    try {
      const diskMarkdown = paths ? countIndexableMarkdownOnDisk(paths.desktopRoot) : 0;
      const pageCount = (await fetchGbrainMcpTotalPages(12_000)) ?? 0;
      return {
        ok: true,
        indexed_ok: gbrainIndexedOk(diskMarkdown, pageCount),
        page_count: pageCount,
        disk_markdown: diskMarkdown,
      };
    } catch {
      return { ok: true };
    }
  }

  if (mcp.reachable) {
    return { ok: false };
  }

  // MCP offline — quick CLI probe only when nothing holds PGLite.
  if (!paths) return { ok: false };
  try {
    await runGbrain(["doctor", "--json", "--fast"], 5_000, 1);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Walk Desktop tree counting .md/.mdx (sync with scripts/lib/gbrain-index-health.mjs). */
function countIndexableMarkdownOnDisk(root: string, maxDepth = 24): number {
  if (!root.trim()) return 0;
  let count = 0;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.mdx?$/i.test(name)) {
        count += 1;
      }
    }
  }

  walk(path.resolve(root), 0);
  return count;
}
