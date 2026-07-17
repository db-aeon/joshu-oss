/**
 * Scoped File Brain retrieval for public share-chat.
 * Query gbrain broadly, then keep only hits under the shared path.
 * Always packs shared-disk corpus windows so the answerer can reassemble
 * (gbrain alone is not enough for single large notebooks).
 */

import fs from "node:fs";
import path from "node:path";
import { gbrainMcpQuery, gbrainMcpSearch, formatGbrainCliError } from "../gbrainMcpInspect.js";
import {
  type ShareScope,
  isPathInsideShare,
  isSlugInsideShare,
  normalizeRealPath,
} from "./shareScope.js";

export interface ScopedEvidence {
  slug: string;
  title: string;
  snippet: string;
  score: number;
  source: "gbrain" | "disk";
}

export interface ScopedBrainResult {
  evidence: ScopedEvidence[];
  discardedOutsideScope: number;
  queryError?: string;
  /** True when we loaded shared-disk text because gbrain was empty/thin. */
  usedDiskCorpus: boolean;
}

const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 1800;
const MAX_DISK_FILES = 60;
const MAX_DISK_BYTES = 240_000;
const MAX_FILE_READ_BYTES = 2_000_000;

function parseHits(raw: string): Array<{
  slug: string;
  title: string;
  snippet: string;
  score: number;
}> {
  const trimmed = raw.trim();
  if (!trimmed || /^no results\.?$/i.test(trimmed)) return [];

  let parsed: unknown = trimmed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    /* text fallback below */
  }

  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown[] }).results)
      ? ((parsed as { results: unknown[] }).results)
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { hits?: unknown[] }).hits)
        ? ((parsed as { hits: unknown[] }).hits)
        : [];

  const out: Array<{ slug: string; title: string; snippet: string; score: number }> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? r.slug.trim() : "";
    if (!slug) continue;
    const snippetRaw =
      typeof r.chunk_text === "string"
        ? r.chunk_text
        : typeof r.snippet === "string"
          ? r.snippet
          : typeof r.text === "string"
            ? r.text
            : "";
    const title =
      typeof r.title === "string" && r.title.trim()
        ? r.title.trim()
        : path.basename(slug);
    const score =
      typeof r.score === "number"
        ? r.score
        : typeof r.base_score === "number"
          ? r.base_score
          : 0;
    out.push({
      slug,
      title,
      snippet: snippetRaw.trim().slice(0, MAX_SNIPPET_CHARS),
      score,
    });
  }

  if (out.length === 0) {
    for (const line of trimmed.split(/\r?\n/)) {
      const m = /^([^\s:]+)\s*:\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      out.push({
        slug: m[1]!,
        title: path.basename(m[1]!),
        snippet: m[2]!.slice(0, MAX_SNIPPET_CHARS),
        score: 0,
      });
    }
  }
  return out;
}

function questionTokens(question: string): string[] {
  const stop = new Set([
    "what", "whats", "which", "where", "when", "who", "whom", "whose",
    "why", "how", "is", "are", "was", "were", "the", "a", "an", "and",
    "or", "to", "for", "of", "in", "on", "with", "from", "about", "good",
    "best", "please", "tell", "me", "can", "you", "give", "show",
  ]);
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !stop.has(t))
    .slice(0, 16);
}

/** Expand one user question into several retrieval queries. */
export function buildRetrievalQueries(question: string): string[] {
  const q = question.trim();
  const tokens = questionTokens(q);
  const out = new Set<string>();
  if (q) out.add(q);
  if (tokens.length) out.add(tokens.join(" "));
  // Phrase-ish pairs help hybrid search on long notebooks
  for (let i = 0; i < tokens.length - 1; i++) {
    out.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return [...out].slice(0, 5);
}

function collectCorpusFiles(scope: ShareScope): string[] {
  const files: string[] = [];
  const rootNorm = normalizeRealPath(scope.allowedRealRoot);
  if (!fs.existsSync(rootNorm)) return files;

  const pushIfReadable = (p: string) => {
    if (/\.(md|txt|markdown)$/i.test(p)) files.push(p);
  };

  if (!scope.isFolder) {
    pushIfReadable(rootNorm);
    if (/\.pdf$/i.test(rootNorm)) {
      const sibling = rootNorm.replace(/\.pdf$/i, ".md");
      if (fs.existsSync(sibling)) files.push(sibling);
    }
    // Always keep the shared file itself even if not markdown (read as text later)
    if (!files.includes(rootNorm) && fs.statSync(rootNorm).isFile()) {
      files.push(rootNorm);
    }
    return files.slice(0, MAX_DISK_FILES);
  }

  const walk = (dir: string, depth: number) => {
    if (files.length >= MAX_DISK_FILES || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files.length >= MAX_DISK_FILES) break;
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) pushIfReadable(full);
    }
  };
  walk(rootNorm, 0);
  return files;
}

function windowsAroundKeywords(
  text: string,
  tokens: string[],
  maxWindows: number,
): Array<{ snippet: string; score: number }> {
  const lower = text.toLowerCase();
  const windows: Array<{ start: number; score: number }> = [];
  const seen = new Set<number>();

  // Prefer phrase anchors when the question is about scripts/calls
  const phraseBoosts = ["sample script", "call script", "scripts for", "phone script", "opening dialogue"];
  for (const phrase of phraseBoosts) {
    if (!tokens.some((t) => phrase.includes(t))) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(phrase, from);
      if (idx < 0) break;
      const start = Math.max(0, idx - 120);
      const bucket = Math.floor(start / 900);
      if (!seen.has(bucket)) {
        seen.add(bucket);
        windows.push({ start, score: 20 });
      }
      from = idx + phrase.length;
    }
  }

  for (const t of tokens) {
    let from = 0;
    while (from < lower.length && windows.length < maxWindows * 4) {
      const idx = lower.indexOf(t, from);
      if (idx < 0) break;
      const start = Math.max(0, idx - 350);
      const bucket = Math.floor(start / 900);
      if (!seen.has(bucket)) {
        seen.add(bucket);
        const region = lower.slice(start, start + MAX_SNIPPET_CHARS);
        let score = 1;
        for (const tok of tokens) {
          if (region.includes(tok)) score += 2;
        }
        // Phone-number-only hits are weak for "phone script" questions
        if (t === "phone" && !/\bscript\b/.test(region) && !/\bcall script\b/.test(region)) {
          score = Math.max(1, score - 2);
        }
        if (/\bscript\b/.test(region)) score += 4;
        windows.push({ start, score });
      }
      from = idx + t.length;
    }
  }

  windows.sort((a, b) => b.score - a.score);
  const picked = windows.slice(0, maxWindows).map((w) => ({
    snippet: text.slice(w.start, w.start + MAX_SNIPPET_CHARS).trim(),
    score: w.score,
  }));

  // Always include the head of the file so structure/TOC is available
  if (picked.length === 0 || tokens.length === 0) {
    picked.unshift({
      snippet: text.slice(0, MAX_SNIPPET_CHARS).trim(),
      score: 1,
    });
  } else {
    picked.push({
      snippet: text.slice(0, Math.min(MAX_SNIPPET_CHARS, 1200)).trim(),
      score: 1,
    });
  }

  return picked.slice(0, maxWindows);
}

/**
 * Pack shared-disk evidence. For single-file shares, always include windows
 * from that file (large notebooks were previously skipped by a hard size cap).
 */
export function packDiskCorpus(question: string, scope: ShareScope): ScopedEvidence[] {
  const tokens = questionTokens(question);
  const files = collectCorpusFiles(scope);
  const scored: ScopedEvidence[] = [];
  let bytes = 0;

  for (const file of files) {
    if (!isPathInsideShare(file, scope) && normalizeRealPath(file) !== scope.allowedRealRoot) {
      continue;
    }
    let text = "";
    try {
      const st = fs.statSync(file);
      // Single shared file: always read (cap to MAX_FILE_READ_BYTES).
      // Folder members: skip huge binaries.
      if (scope.isFolder && st.size > 400_000 && !/\.(md|txt|markdown)$/i.test(file)) continue;
      if (st.size > MAX_FILE_READ_BYTES) {
        text = fs.readFileSync(file, "utf8").slice(0, MAX_FILE_READ_BYTES);
      } else {
        text = fs.readFileSync(file, "utf8");
      }
    } catch {
      continue;
    }
    if (!text.trim()) continue;

    const maxWindows = scope.isFolder ? 2 : 6;
    const windows = windowsAroundKeywords(text, tokens, maxWindows);
    const rel =
      path.relative(scope.isFolder ? scope.allowedRealRoot : path.dirname(scope.allowedRealRoot), file)
        .replace(/\\/g, "/") || path.basename(file);

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!;
      bytes += w.snippet.length;
      if (bytes > MAX_DISK_BYTES && scored.length > 0) break;
      scored.push({
        slug: rel.replace(/\.md$/i, ""),
        title: path.basename(file) + (windows.length > 1 ? ` §${i + 1}` : ""),
        snippet: w.snippet,
        score: w.score + (scope.isFolder ? 0 : 5), // prefer shared file itself
        source: "disk",
      });
    }
    if (bytes > MAX_DISK_BYTES) break;
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_SNIPPETS);
}

function dedupeEvidence(items: ScopedEvidence[]): ScopedEvidence[] {
  const out: ScopedEvidence[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.slug}::${item.snippet.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Retrieve evidence constrained to the share scope.
 * Never returns snippets from outside the shared path.
 */
export async function queryScopedBrain(
  question: string,
  scope: ShareScope,
  opts?: { limit?: number },
): Promise<ScopedBrainResult> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 5), 40);
  let discardedOutsideScope = 0;
  let queryError: string | undefined;
  const kept: ScopedEvidence[] = [];

  const queries = buildRetrievalQueries(question);
  try {
    for (const q of queries) {
      let raw = "";
      try {
        raw = await gbrainMcpQuery(q, limit);
      } catch {
        try {
          raw = await gbrainMcpSearch(q, limit);
        } catch (err) {
          queryError = formatGbrainCliError(err);
          continue;
        }
      }
      for (const hit of parseHits(raw)) {
        if (!isSlugInsideShare(hit.slug, scope)) {
          discardedOutsideScope += 1;
          continue;
        }
        kept.push({
          slug: hit.slug,
          title: hit.title,
          snippet: hit.snippet,
          score: hit.score,
          source: "gbrain",
        });
      }
    }
  } catch (err) {
    queryError = formatGbrainCliError(err);
  }

  // Always pack shared-disk windows for single-file shares, or when gbrain
  // returned nothing useful in-scope. Lets the LLM reassemble answers from
  // long notebooks that keyword-only / slug-mismatched retrieval misses.
  let usedDiskCorpus = false;
  const needDisk =
    !scope.isFolder || kept.length < 3 || discardedOutsideScope > 0 && kept.length === 0;
  if (needDisk) {
    const diskHits = packDiskCorpus(question, scope);
    if (diskHits.length) {
      usedDiskCorpus = true;
      kept.push(...diskHits);
    }
  }

  const evidence = dedupeEvidence(kept)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SNIPPETS);

  return {
    evidence,
    discardedOutsideScope,
    queryError,
    usedDiskCorpus,
  };
}

export { MAX_SNIPPETS };
