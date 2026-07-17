/**
 * Resolve an ArozOS share UUID to a file/folder scope for public share-chat.
 *
 * Shares live in ArozOS BoltDB (`${AROZ_DATA}/system/ao.db`) as JSON ShareOption
 * blobs. We parse those without vendor Go deps.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";

export interface ShareScope {
  uuid: string;
  owner: string;
  permission: string;
  isFolder: boolean;
  fileVirtualPath: string;
  fileRealPath: string;
  /** Display name (basename). */
  displayName: string;
  /** Absolute real path that retrieval must stay under. */
  allowedRealRoot: string;
  /** Path prefixes used to match gbrain page slugs (lowercased). */
  slugPrefixes: string[];
  /** True when the shared path still exists on disk. */
  valid: boolean;
}

export interface ShareOptionRecord {
  UUID: string;
  PathHash?: string;
  FileVirtualPath: string;
  FileRealPath: string;
  Owner: string;
  Accessibles?: string[];
  Permission: string;
  IsFolder: boolean;
}

function arozDataRoot(projectRoot = process.cwd()): string {
  return path.resolve(
    process.env.AROZ_DATA?.trim() || path.join(projectRoot, ".local", "arozos-data"),
  );
}

function aoDbPath(projectRoot = process.cwd()): string {
  return path.join(arozDataRoot(projectRoot), "system", "ao.db");
}

/**
 * Extract ShareOption JSON objects from ArozOS ao.db binary.
 * Layout stores `uuid{json}` pairs; we scan for JSON with a UUID field.
 */
export function listShareOptionsFromAoDb(projectRoot = process.cwd()): ShareOptionRecord[] {
  const dbPath = aoDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) return [];
  const buf = fs.readFileSync(dbPath);
  // ASCII-safe scan for {"UUID":"..."} blobs
  const text = buf.toString("latin1");
  const out: ShareOptionRecord[] = [];
  const seen = new Set<string>();
  const re = /\{"UUID":"[0-9a-fA-F-]{36}"[^]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    // Truncate to first balanced JSON object (strings may contain braces rarely)
    const json = extractBalancedJson(raw);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as ShareOptionRecord;
      if (!parsed?.UUID || !parsed.FileVirtualPath || !parsed.FileRealPath) continue;
      if (seen.has(parsed.UUID)) continue;
      seen.add(parsed.UUID);
      out.push(parsed);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

function extractBalancedJson(s: string): string | null {
  if (!s.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

export function findShareOptionByUuid(
  uuid: string,
  projectRoot = process.cwd(),
): ShareOptionRecord | null {
  const needle = uuid.trim().toLowerCase();
  if (!needle) return null;
  return (
    listShareOptionsFromAoDb(projectRoot).find((s) => s.UUID.toLowerCase() === needle) || null
  );
}

/** Normalize path for prefix checks (POSIX, no trailing slash except root). */
export function normalizeRealPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

/**
 * Build slug prefixes that gbrain may use for pages under this share.
 * gbrain lowercases, strips apostrophes, turns spaces into hyphens, and drops `.md`.
 */
export function normalizeSlugKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-|-$/g, "");
}

export function buildSlugPrefixes(fileVirtualPath: string, fileRealPath: string): string[] {
  const prefixes = new Set<string>();
  const add = (raw: string) => {
    const cleaned = raw.replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!cleaned) return;
    prefixes.add(cleaned);
    prefixes.add(cleaned.toLowerCase());
    prefixes.add(normalizeSlugKey(cleaned));
    // Also keep hyphenated path form gbrain uses (`joshus-files/hua-team-notebook`)
    const hyp = cleaned
      .toLowerCase()
      .replace(/['']/g, "")
      .replace(/\.md$/i, "")
      .replace(/\s+/g, "-");
    if (hyp) prefixes.add(hyp);
  };

  const v = fileVirtualPath.replace(/^user:\/*/, "").replace(/^Desktop\//i, "");
  add(v);
  add(v.replace(/'/g, ""));
  add(v.replace(/joshu's files/gi, "joshus-files"));
  add(v.replace(/joshu's files/gi, "joshus files"));

  const paths = resolveJoshuFilesPaths();
  if (paths) {
    const real = normalizeRealPath(fileRealPath);
    const desktop = normalizeRealPath(paths.desktopRoot);
    const filesRoot = normalizeRealPath(paths.filesRoot);
    if (real.startsWith(desktop + "/") || real === desktop) {
      const rel = real.slice(desktop.length).replace(/^\/+/, "");
      if (rel) add(rel);
    }
    if (real.startsWith(filesRoot + "/") || real === filesRoot) {
      const rel = real.slice(filesRoot.length).replace(/^\/+/, "");
      if (rel) {
        add(rel);
        add(`joshus-files/${rel}`);
        add(`joshu's files/${rel}`);
      } else {
        add("joshus-files");
        add("joshu's files");
      }
    }
  }

  // Basename without extension (file shares)
  const base = path.basename(fileRealPath).replace(/\.md$/i, "");
  if (base) {
    add(base);
    add(base.replace(/\s+/g, "-"));
  }

  return [...prefixes].filter(Boolean);
}

export function resolveShareScope(
  uuid: string,
  projectRoot = process.cwd(),
): ShareScope | null {
  const opt = findShareOptionByUuid(uuid, projectRoot);
  if (!opt) return null;

  // Public chat is only for anyone-with-link shares for now.
  if (opt.Permission && opt.Permission !== "anyone") {
    // Still resolve metadata, but mark invalid for public access.
  }

  const real = normalizeRealPath(opt.FileRealPath);
  const exists = fs.existsSync(real);
  const displayName = path.basename(opt.FileVirtualPath.replace(/\/+$/, "")) || opt.UUID;

  return {
    uuid: opt.UUID,
    owner: opt.Owner,
    permission: opt.Permission || "anyone",
    isFolder: Boolean(opt.IsFolder),
    fileVirtualPath: opt.FileVirtualPath,
    fileRealPath: real,
    displayName,
    allowedRealRoot: real,
    slugPrefixes: buildSlugPrefixes(opt.FileVirtualPath, real),
    valid: exists && (!opt.Permission || opt.Permission === "anyone"),
  };
}

/** True if a real filesystem path is inside the share root. */
export function isPathInsideShare(candidateRealPath: string, scope: ShareScope): boolean {
  const cand = normalizeRealPath(candidateRealPath);
  const root = scope.allowedRealRoot;
  if (cand === root) return true;
  const prefix = root.endsWith("/") ? root : root + "/";
  return cand.startsWith(prefix);
}

/** True if a gbrain slug appears to belong to this share. */
export function isSlugInsideShare(slug: string, scope: ShareScope): boolean {
  const sRaw = slug.trim().toLowerCase().replace(/^\/+/, "");
  if (!sRaw) return false;
  const sNorm = normalizeSlugKey(sRaw);

  for (const prefix of scope.slugPrefixes) {
    const pRaw = prefix.toLowerCase().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!pRaw) continue;
    if (sRaw === pRaw || sRaw.startsWith(pRaw + "/")) return true;
    const pNorm = normalizeSlugKey(pRaw);
    if (!pNorm) continue;
    if (sNorm === pNorm || sNorm.startsWith(pNorm + "/") || sNorm.endsWith("/" + pNorm)) {
      return true;
    }
  }

  // Basename fallback for single-file shares (spaces vs hyphens)
  if (!scope.isFolder) {
    const base = normalizeSlugKey(path.basename(scope.fileRealPath).replace(/\.md$/i, ""));
    if (base && (sNorm === base || sNorm.endsWith("/" + base) || sNorm.includes("/" + base + "/"))) {
      return true;
    }
  }
  return false;
}
