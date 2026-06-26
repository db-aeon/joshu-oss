/**
 * Compare on-disk markdown vs gbrain MCP index — used by ensure-gbrain-indexed.sh
 * and instance health probes.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INDEXABLE = /\.mdx?$/i;

/**
 * @param {string} root
 * @param {{ maxDepth?: number; minCount?: number }} [opts]
 * @returns {Promise<number>}
 */
export async function countIndexableMarkdown(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? 24;
  const minCount = opts.minCount ?? Number.POSITIVE_INFINITY;
  if (!root?.trim()) return 0;

  let count = 0;

  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    if (depth > maxDepth || count >= minCount) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (INDEXABLE.test(ent.name)) {
        count += 1;
        if (count >= minCount) return;
      }
    }
  }

  await walk(path.resolve(root), 0);
  return count;
}

/**
 * Sum page counts from `sources_list` JSON or `gbrain sources list` text.
 *
 * @param {string} raw
 * @returns {number | null}
 */
export function parseTotalPagesFromSourcesPayload(raw) {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.sources)) {
      let total = 0;
      let found = false;
      for (const src of parsed.sources) {
        if (src && typeof src === "object" && typeof src.page_count === "number") {
          total += src.page_count;
          found = true;
        }
      }
      return found ? total : null;
    }
  } catch {
    /* fall through to CLI-style lines */
  }
  let total = 0;
  let found = false;
  for (const line of raw.split(/\r?\n/)) {
    const match = /(\d+)\s+pages\b/i.exec(line);
    if (!match) continue;
    total += Number.parseInt(match[1], 10) || 0;
    found = true;
  }
  return found ? total : null;
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function parseMcpListPageCount(raw) {
  if (!raw) return 0;
  if (typeof raw === "string") {
    try {
      return parseMcpListPageCount(JSON.parse(raw));
    } catch {
      return 0;
    }
  }
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === "object" && raw !== null) {
    const obj = /** @type {Record<string, unknown>} */ (raw);
    if (Array.isArray(obj.pages)) return obj.pages.length;
    if (Array.isArray(obj.results)) return obj.results.length;
    if (typeof obj.raw === "string") return parseMcpListPageCount(obj.raw);
  }
  return 0;
}

/** Keep in sync with src/gbrainIndexCoverage.ts */
export function defaultMinCoverageRatio() {
  const raw = process.env.GBRAIN_INDEX_MIN_COVERAGE_RATIO?.trim();
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.5;
}

/**
 * @param {number} diskMarkdown
 * @param {number} indexedPages
 * @param {{ minDiskFiles?: number; minCoverageRatio?: number }} [opts]
 */
export function assessIndexCoverage(diskMarkdown, indexedPages, opts = {}) {
  const minDiskFiles = opts.minDiskFiles ?? 1;
  const minCoverageRatio = opts.minCoverageRatio ?? defaultMinCoverageRatio();
  const hasDiskContent = diskMarkdown >= minDiskFiles;
  const hasIndexedContent = indexedPages > 0;
  const coverageOk =
    diskMarkdown === 0 ||
    (hasIndexedContent && indexedPages >= diskMarkdown * minCoverageRatio);
  const needsRecovery = hasDiskContent && !coverageOk;
  return {
    hasDiskContent,
    hasIndexedContent,
    coverageOk,
    needsRecovery,
    healthy: !needsRecovery,
    minCoverageRatio,
  };
}

/**
 * Total indexed pages via MCP REST /sources (not /list sample).
 *
 * @param {string} mcpBaseUrl
 * @param {number} [timeoutMs]
 * @returns {Promise<number>}
 */
export async function probeMcpTotalPages(mcpBaseUrl, timeoutMs = 12_000) {
  const base = mcpBaseUrl.replace(/\/+$/, "");
  try {
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)),
      cache: "no-store",
    });
    if (!health.ok) return -1;
    const healthBody = /** @type {{ session_ready?: boolean }} */ (await health.json());
    if (healthBody.session_ready !== true) return -1;

    const sources = await fetch(`${base}/sources`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!sources.ok) return -1;
    const body = /** @type {{ ok?: boolean; total_pages?: number; raw?: string }} */ (
      await sources.json()
    );
    if (!body.ok) return -1;
    if (typeof body.total_pages === "number") return body.total_pages;
    if (body.raw) {
      const total = parseTotalPagesFromSourcesPayload(body.raw);
      return total ?? -1;
    }
    return -1;
  } catch {
    return -1;
  }
}

/** @deprecated Use probeMcpTotalPages — /list capped samples under-report totals. */
export async function probeMcpPageCount(mcpBaseUrl, timeoutMs = 12_000) {
  return probeMcpTotalPages(mcpBaseUrl, timeoutMs);
}

/**
 * @param {{
 *   desktopRoot?: string;
 *   mcpBaseUrl?: string;
 *   minDiskFiles?: number;
 * }} params
 */
export async function assessGbrainIndexHealth(params = {}) {
  const desktopRoot = params.desktopRoot?.trim() || "";
  const mcpBaseUrl = params.mcpBaseUrl?.trim() || "http://127.0.0.1:8794";
  const minDiskFiles = params.minDiskFiles ?? 1;

  const diskMarkdown = desktopRoot ? await countIndexableMarkdown(desktopRoot) : 0;
  const indexedRaw = await probeMcpTotalPages(mcpBaseUrl);
  const indexedPages = Math.max(0, indexedRaw);

  const mcpReady = indexedRaw >= 0;
  const coverage = assessIndexCoverage(diskMarkdown, indexedPages, { minDiskFiles });
  const needsRecovery = mcpReady && coverage.needsRecovery;

  return {
    desktopRoot,
    mcpBaseUrl,
    diskMarkdown,
    indexedPages,
    mcpReady,
    hasDiskContent: coverage.hasDiskContent,
    hasIndexedContent: coverage.hasIndexedContent,
    coverageOk: coverage.coverageOk,
    minCoverageRatio: coverage.minCoverageRatio,
    needsRecovery,
    healthy: coverage.healthy,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes("--json");
  const desktopRoot =
    process.argv.slice(2).find((a) => !a.startsWith("-"))?.trim() ||
    process.env.JOSHU_DESKTOP_ROOT?.trim() ||
    "";
  const mcpBaseUrl = process.env.GBRAIN_MCP_HTTP_URL?.trim() || "http://127.0.0.1:8794";

  const report = await assessGbrainIndexHealth({ desktopRoot, mcpBaseUrl });

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(report.needsRecovery ? 2 : 0);
  }

  process.stdout.write(
    `[gbrain-index-health] disk=${report.diskMarkdown} indexed=${report.indexedPages} coverage_ok=${report.coverageOk} min_ratio=${report.minCoverageRatio} needs_recovery=${report.needsRecovery}\n`,
  );
  process.exit(report.needsRecovery ? 2 : 0);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
