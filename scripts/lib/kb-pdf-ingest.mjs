/**
 * Watch JOSHU_DESKTOP_ROOT for PDFs → ingest-pdf-kb.py → sibling markdown + gbrain reindex.
 *
 * PDFs stay in place; extracted text is written alongside (report.pdf → report.md).
 * Scope matches gbrain's federated Desktop index (not only joshu's files).
 */

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INGEST_SCRIPT = path.join(__dirname, "..", "ingest-pdf-kb.py");

/** @type {KbPdfIngestStatus} */
let status = {
  active: false,
  phase: "idle",
  reason: "",
  last_run_at: null,
  last_message: "",
  last_ingested: 0,
  last_updated: 0,
  last_removed: 0,
  last_errors: 0,
};

/**
 * @typedef {{
 *   active: boolean,
 *   phase: "idle" | "scheduled" | "running",
 *   reason: string,
 *   last_run_at: string | null,
 *   last_message: string,
 *   last_ingested: number,
 *   last_updated: number,
 *   last_removed: number,
 *   last_errors: number,
 * }} KbPdfIngestStatus
 */

/**
 * @returns {KbPdfIngestStatus}
 */
export function getKbPdfIngestStatus() {
  return { ...status };
}

/**
 * @param {string} relPath
 */
function isPdfUnderRoot(relPath) {
  if (!relPath) return false;
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  if (!norm.endsWith(".pdf")) return false;
  // Ignore junk / archive leftovers if anything still lands under .raw
  if (norm.includes("/.raw/") || norm.includes("/.git/")) return false;
  // ArozOS trash — deleted folders still contain PDFs; never re-ingest them.
  if (norm.includes("/.metadata/") || norm.startsWith(".metadata/")) return false;
  return true;
}

/**
 * @param {{
 *   desktopRoot?: string,
 *   filesRoot?: string,
 *   debounceMs?: number,
 *   pollSec?: number,
 *   scheduleReindex?: (ms?: number) => void,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function startKbPdfIngest(opts) {
  // Prefer full Desktop so PDF extract matches federated gbrain indexing scope.
  const scanRoot = (opts.desktopRoot || opts.filesRoot || "").trim();
  if (!scanRoot) {
    opts.log?.("[kb-pdf-ingest] disabled (JOSHU_DESKTOP_ROOT unset)");
    return { getStatus: getKbPdfIngestStatus };
  }

  const debounceMs = Math.max(1000, opts.debounceMs ?? 2500);
  const pollSec = Math.max(30, opts.pollSec ?? 120);
  const python = process.env.JOSHU_KB_PDF_PYTHON?.trim() || "python3";
  const appDir = process.env.APP_DIR?.trim() || path.join(__dirname, "..", "..");

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let running = false;
  let pending = false;
  /** Signature of the last logged outcome — suppresses identical poll spam. */
  let lastOutcomeSignature = "";

  function log(msg) {
    opts.log?.(`[kb-pdf-ingest] ${msg}`);
  }

  function setStatus(patch) {
    status = { ...status, ...patch, active: patch.phase === "running" || patch.phase === "scheduled" };
  }

  function runIngest(reason, singlePdf) {
    if (running) {
      pending = true;
      setStatus({ phase: "scheduled", reason: `${reason} (queued)` });
      return;
    }
    running = true;
    setStatus({
      phase: "running",
      reason,
      last_message: singlePdf ? `Extracting ${path.basename(singlePdf)}…` : "Extracting PDFs…",
    });

    const args = [INGEST_SCRIPT, "--root", scanRoot];
    if (singlePdf) {
      args.push("--pdf", singlePdf);
    }

    const child = spawn(python, args, {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      running = false;
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const stderrText = stderr.trim();
      const ingested = lines.filter((line) => line.startsWith("ingested ")).length;
      const updated = lines.filter((line) => line.startsWith("updated ")).length;
      const removed = lines.filter((line) => line.startsWith("removed ")).length;
      const errors = lines.filter((line) => line.startsWith("error ")).length;
      const changed = ingested + updated + removed > 0;

      // Collapse repeated identical outcomes (e.g. the same extractor error on
      // every 120s poll) to a single log line. A successful ingest always logs.
      const signature = JSON.stringify({ code, lines, stderrText });
      const isRepeat = signature === lastOutcomeSignature;
      lastOutcomeSignature = signature;

      if (changed || !isRepeat) {
        for (const line of lines) {
          log(`${reason}: ${line}`);
        }
        if (stderrText) {
          log(`${reason}: stderr ${stderrText.slice(0, 400)}`);
        }
        if (code !== 0 && lines.length === 0) {
          log(`${reason}: ingest exited ${code ?? "?"}`);
        }
        if (isRepeat === false && lines.some((line) => line.includes("no PDF text extractor installed"))) {
          log(`${reason}: auto-ingest is stalled until an extractor is installed (see log line above)`);
        }
      }

      const summary =
        lines.length === 0
          ? "No PDFs to process"
          : `${ingested} new, ${updated} updated, ${removed} removed, ${errors} errors`;

      setStatus({
        phase: pending ? "scheduled" : "idle",
        reason: pending ? "follow-up" : "",
        last_run_at: new Date().toISOString(),
        last_message: summary,
        last_ingested: ingested,
        last_updated: updated,
        last_removed: removed,
        last_errors: errors,
      });

      if (changed) {
        opts.scheduleReindex?.(500);
      }
      if (pending) {
        pending = false;
        scheduleRun("follow-up");
      }
    });
  }

  /** @type {string | undefined} */
  let pendingPdf;

  function scheduleRun(reason, singlePdf) {
    if (timer) clearTimeout(timer);
    if (singlePdf) pendingPdf = singlePdf;
    setStatus({
      phase: running ? "running" : "scheduled",
      reason,
      active: true,
    });
    timer = setTimeout(() => {
      timer = null;
      const pdf = pendingPdf;
      pendingPdf = undefined;
      // Single-file only for watch events on a PDF that still exists; a missing
      // PDF means it was deleted — full scan runs orphan-sidecar cleanup.
      const useSingle = pdf && reason.startsWith("watch ") && existsSync(pdf);
      runIngest(reason, useSingle ? pdf : undefined);
    }, debounceMs);
  }

  // Event-driven: ingest only the PDF that changed (avoids full-tree hash on every drop).
  try {
    watch(scanRoot, { recursive: true }, (_event, filename) => {
      if (!isPdfUnderRoot(filename || "")) return;
      const abs = path.join(scanRoot, filename);
      scheduleRun(`watch ${filename}`, abs);
    });
    log(`watching ${scanRoot} (recursive, *.pdf)`);
  } catch (err) {
    log(`desktop watch failed: ${err instanceof Error ? err.message : err}`);
  }

  setInterval(() => scheduleRun("poll"), pollSec * 1000);
  scheduleRun("startup");

  return { getStatus: getKbPdfIngestStatus };
}
