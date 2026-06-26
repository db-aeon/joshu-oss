/**
 * Watch research/kb/inbox/ for PDF drops → ingest-pdf-kb.py → markdown + gbrain reindex.
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INGEST_SCRIPT = path.join(__dirname, "..", "ingest-pdf-kb.py");
const INBOX_SUFFIX = `${path.sep}research${path.sep}kb${path.sep}inbox${path.sep}`;

/**
 * @param {string} relPath
 */
function isKbInboxPdf(relPath) {
  if (!relPath) return false;
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  return norm.includes("/research/kb/inbox/") && norm.endsWith(".pdf");
}

/**
 * @param {(msg: string) => void} log
 * @param {{ filesRoot?: string; debounceMs?: number; pollSec?: number; scheduleReindex?: (ms?: number) => void }} opts
 */
export function startKbPdfIngest(opts) {
  const filesRoot = opts.filesRoot?.trim();
  if (!filesRoot) {
    log("kb-pdf-ingest disabled (JOSHU_FILES_ROOT unset)");
    return;
  }

  const inboxDir = path.join(filesRoot, "research", "kb", "inbox");
  const debounceMs = Math.max(1000, opts.debounceMs ?? 2500);
  const pollSec = Math.max(30, opts.pollSec ?? 120);
  const python = process.env.JOSHU_KB_PDF_PYTHON?.trim() || "python3";
  const appDir = process.env.APP_DIR?.trim() || path.join(__dirname, "..", "..");

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let running = false;
  let pending = false;

  function log(msg) {
    opts.log?.(`[kb-pdf-ingest] ${msg}`);
  }

  function runIngest(reason) {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const child = spawn(
      python,
      [INGEST_SCRIPT, "--files-root", filesRoot],
      {
        cwd: appDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
      for (const line of lines) {
        log(`${reason}: ${line}`);
      }
      if (stderr.trim()) {
        log(`${reason}: stderr ${stderr.trim().slice(0, 400)}`);
      }
      if (code !== 0 && lines.length === 0) {
        log(`${reason}: ingest exited ${code ?? "?"}`);
      }
      if (lines.some((line) => line.startsWith("ingested "))) {
        opts.scheduleReindex?.(500);
      }
      if (pending) {
        pending = false;
        scheduleRun("follow-up");
      }
    });
  }

  function scheduleRun(reason) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runIngest(reason);
    }, debounceMs);
  }

  try {
    watch(inboxDir, (_event, filename) => {
      if (filename && !filename.toLowerCase().endsWith(".pdf")) return;
      scheduleRun(`watch ${filename || "inbox"}`);
    });
    log(`watching ${inboxDir}`);
  } catch (err) {
    log(`inbox watch failed: ${err instanceof Error ? err.message : err}`);
  }

  if (opts.scheduleReindex) {
    const desktopRoot = process.env.JOSHU_DESKTOP_ROOT?.trim() || filesRoot;
    try {
      watch(desktopRoot, { recursive: true }, (_event, filename) => {
        if (!isKbInboxPdf(filename || "")) return;
        scheduleRun(`desktop-watch ${filename}`);
      });
    } catch {
      /* inbox-only watch is enough on platforms without recursive watch */
    }
  }

  setInterval(() => scheduleRun("poll"), pollSec * 1000);
  scheduleRun("startup");
}
