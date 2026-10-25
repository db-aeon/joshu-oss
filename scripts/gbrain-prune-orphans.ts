#!/usr/bin/env bun
/**
 * Soft-delete gbrain pages whose Desktop file no longer exists.
 *
 * Incremental sync handles moves/deletes from the git diff, but a full sync
 * re-imports what is on disk, never deletes, and advances the bookmark past
 * the commits that recorded the moves — so the old pages stay forever
 * (~1,800 fleet-wide in 2026-10, mostly Triage stubs moved to _done/).
 *
 * Uses gbrain's own walker + slug rules, so "file exists" matches how gbrain
 * named the page. Soft delete: hidden from search immediately, restorable for
 * 72h (`gbrain restore <slug>`), then purged by gbrain.
 *
 * Needs the PGLite lock (gbrain serve stopped) — run from start-gbrain.sh.
 * Usage: bun gbrain-prune-orphans.ts <desktop-root> [--apply]
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/** Refuse to delete when this share of the index looks orphaned (wrong root, unmounted disk). */
const MAX_ORPHAN_FRACTION = 0.5;

const desktop = process.argv[2];
const apply = process.argv.includes("--apply");
const pkg =
  process.env.GBRAIN_PKG_DIR?.trim() || join(homedir(), ".bun", "install", "global", "node_modules", "gbrain");
const log = (msg: string) => console.log(`[gbrain-prune-orphans] ${msg}`);

if (!desktop || !existsSync(desktop)) {
  log(`skip: desktop root missing (${desktop ?? "unset"})`);
  process.exit(0);
}
if (!existsSync(join(pkg, "package.json"))) {
  log(`skip: gbrain not found at ${pkg}`);
  process.exit(0);
}

const { loadConfig, toEngineConfig } = await import(join(pkg, "src/core/config.ts"));
const { createEngine } = await import(join(pkg, "src/core/engine-factory.ts"));
const { collectMarkdownFiles } = await import(join(pkg, "src/commands/import.ts"));
const { slugifyPath } = await import(join(pkg, "src/core/sync.ts"));

const files: string[] = collectMarkdownFiles(desktop);
if (files.length === 0) {
  log("skip: walker found no markdown files");
  process.exit(0);
}
const live = new Set(files.map((f) => slugifyPath(relative(desktop, f))));

const cfg = loadConfig();
if (!cfg) {
  log("skip: no gbrain config");
  process.exit(0);
}
const engineConfig = toEngineConfig(cfg);
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);

async function prune(): Promise<void> {
  const pages: { slug: string }[] = await engine.listPages({ limit: 1_000_000 });
  const orphans = pages.filter((p) => !live.has(p.slug)).map((p) => p.slug);
  log(`files=${files.length} pages=${pages.length} orphans=${orphans.length}${apply ? "" : " (dry run)"}`);
  if (orphans.length === 0) return;
  for (const slug of orphans.slice(0, 5)) log(`  e.g. ${slug}`);
  if (orphans.length > pages.length * MAX_ORPHAN_FRACTION) {
    log(`refusing: ${orphans.length}/${pages.length} pages look orphaned (> ${MAX_ORPHAN_FRACTION * 100}%)`);
    return;
  }
  if (!apply) return;
  let deleted = 0;
  for (const slug of orphans) {
    if (await engine.softDeletePage(slug, { sourceId: "default" })) deleted += 1;
  }
  log(`soft-deleted ${deleted} (restorable 72h: gbrain restore <slug>)`);
}

try {
  await prune();
} finally {
  await engine.disconnect();
}
