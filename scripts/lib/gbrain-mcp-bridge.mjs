/**
 * Single gbrain serve stdio session — shared by HTTP MCP clients and REST inspect.
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { filterReadOnlyToolList, isReadOnlyGbrainTool } from "./gbrain-mcp-readonly.mjs";
import { stageDesktopForGbrainSync } from "./gbrain-desktop-git.mjs";
import {
  assessGbrainIndexHealth,
  countIndexableMarkdown,
  parseMcpListPageCount,
} from "./gbrain-index-health.mjs";
import { extractMcpToolText } from "./gbrain-mcp-rest.mjs";
import { normalizeGbrainQueryArgs } from "./gbrain-query-args.mjs";

/**
 * @param {(msg: string) => void} log
 */
export function createGbrainMcpBridge(log) {
  const GBRAIN_BIN = process.env.GBRAIN_BIN?.trim() || "gbrain";
  const GBRAIN_HOME = process.env.GBRAIN_HOME?.trim();
  const FILES_ROOT = process.env.JOSHU_FILES_ROOT?.trim();
  const DESKTOP_ROOT = process.env.JOSHU_DESKTOP_ROOT?.trim() || FILES_ROOT;
  /** Federated sync + fs watch path (Desktop). Git commits use files/users/ only. */
  const SYNC_ROOT = DESKTOP_ROOT || FILES_ROOT;
  const DEBOUNCE_MS = Math.max(
    500,
    Number.parseInt(process.env.GBRAIN_REINDEX_DEBOUNCE_MS || "3000", 10) || 3000,
  );
  /** Periodic git commit + sync_brain (0 = disabled; fs watch + manual reindex only). */
  const REINDEX_INTERVAL_SEC = Math.max(
    0,
    Number.parseInt(process.env.GBRAIN_REINDEX_INTERVAL_SEC || "900", 10) || 900,
  );
  const LOG_FILE = process.env.GBRAIN_LOG_FILE?.trim();
  const REINDEX_TOUCH = GBRAIN_HOME ? path.join(GBRAIN_HOME, ".joshu-reindex-touch") : undefined;
  /** Touch this file to force the next sync_brain with full=true (orphan purge / recovery). */
  const FULL_SYNC_TOUCH = GBRAIN_HOME ? path.join(GBRAIN_HOME, ".joshu-full-sync-touch") : undefined;
  const FULL_SYNC_FLAG = GBRAIN_HOME ? path.join(GBRAIN_HOME, ".joshu-gbrain-needs-full-sync") : undefined;
  const VERBOSE = /^(1|true|yes)$/i.test(process.env.GBRAIN_MCP_VERBOSE?.trim() || "");
  /** After sync_brain, verify index when disk has markdown (catches silent sync failures). */
  const EMPTY_INDEX_CHECK = !/^(0|false|no)$/i.test(process.env.GBRAIN_EMPTY_INDEX_CHECK?.trim() || "true");
  const EMPTY_INDEX_CHECK_SEC = Math.max(
    60,
    Number.parseInt(process.env.GBRAIN_EMPTY_INDEX_CHECK_SEC || "300", 10) || 300,
  );
  const MCP_HTTP_URL = process.env.GBRAIN_MCP_HTTP_URL?.trim() || "http://127.0.0.1:8794";
  const SYNC_RETRY_MAX = Math.max(1, Number.parseInt(process.env.GBRAIN_SYNC_RETRY_MAX || "3", 10) || 3);
  let serveRespawnDelayMs = 2000;
  const SERVE_RESPAWN_MAX_MS = 60_000;
  let syncFailureStreak = 0;
  let emptyIndexStreak = 0;

  /** @type {Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>} */
  const pending = new Map();
  let nextId = 1;
  let internalIdCounter = 900_000;
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  let child = null;
  /** @type {import('node:stream').Writable | null} */
  let childWriter = null;
  let ready = false;
  /** @type {Promise<void> | null} */
  let initPromise = null;
  /** @type {Record<string, unknown> | null} */
  let initResult = null;
  let reindexTimer = null;
  let reindexInFlight = false;
  let pendingReindex = false;
  /** @type {Set<number>} */
  const internalRequestIds = new Set();

  function logLine(msg) {
    const line = `[gbrain-mcp-bridge] ${msg}`;
    log(line);
    if (LOG_FILE) {
      try {
        appendFileSync(LOG_FILE, `${line}\n`);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * gbrain serve speaks NDJSON on stdio (one JSON-RPC object per line), not Content-Length framing.
   * @param {import('node:stream').Writable} stream
   * @param {Record<string, unknown>} obj
   */
  function writeMessage(stream, obj) {
    stream.write(`${JSON.stringify(obj)}\n`);
  }

  /** @param {import('node:stream').Readable} stream */
  function createMcpReader(stream, onMessage) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line));
        } catch (err) {
          logLine(`invalid JSON from gbrain: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  function handleChildMessage(msg) {
    const id = msg.id;
    if (id === undefined || id === null) return;

    if (internalRequestIds.has(id)) {
      internalRequestIds.delete(id);
      if (msg.error) {
        syncFailureStreak += 1;
        logLine(`sync_brain failed (${syncFailureStreak}/${SYNC_RETRY_MAX}): ${JSON.stringify(msg.error)}`);
        if (syncFailureStreak < SYNC_RETRY_MAX) {
          scheduleReindex(Math.min(30_000, 2000 * syncFailureStreak));
        } else if (FULL_SYNC_FLAG) {
          try {
            appendFileSync(FULL_SYNC_FLAG, `${new Date().toISOString()} sync_brain failures\n`);
          } catch {
            /* ignore */
          }
          logLine("sync_brain failed repeatedly — flagged for ensure-gbrain-indexed.sh full recovery");
        }
      } else {
        // MCP sync_brain has no skip_failed; blocked_by_failures still returns
        // a tool "success" while leaving last_commit stuck (stale File Brain).
        const resultText = extractMcpToolText(msg.result);
        const blocked =
          typeof resultText === "string" &&
          (/blocked_by_failures/i.test(resultText) ||
            /Sync blocked:/i.test(resultText));
        if (blocked) {
          syncFailureStreak += 1;
          logLine(
            `sync_brain blocked by file failures (${syncFailureStreak}/${SYNC_RETRY_MAX}) — excluding recorded paths and retrying`,
          );
          // Incremental sync may have left orphan pages (Manuals → trash rename).
          pendingFullSync = true;
          if (syncFailureStreak < SYNC_RETRY_MAX) {
            // stageDesktopForGbrainSync gitignores sync-failures.jsonl paths
            scheduleReindex(Math.min(30_000, 2000 * syncFailureStreak));
          } else if (FULL_SYNC_FLAG) {
            try {
              appendFileSync(FULL_SYNC_FLAG, `${new Date().toISOString()} sync_brain blocked_by_failures\n`);
            } catch {
              /* ignore */
            }
            logLine("sync_brain blocked repeatedly — flagged for ensure-gbrain-indexed.sh full recovery");
          }
        } else {
          syncFailureStreak = 0;
          if (VERBOSE) {
            logLine("sync_brain completed");
          }
          void verifyIndexAfterSync();
        }
      }
      if (pendingReindex) {
        pendingReindex = false;
        scheduleReindex(100);
      }
      reindexInFlight = false;
      return;
    }

    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);

    if (msg.error) {
      const errObj = msg.error;
      const message =
        typeof errObj === "object" && errObj && "message" in errObj
          ? String(/** @type {{ message?: string }} */ (errObj).message)
          : JSON.stringify(errObj);
      entry.reject(new Error(message));
      return;
    }

    entry.resolve(msg.result);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<unknown>}
   */
  function sendRequest(method, params = {}, timeoutMs = 30_000) {
    if (!childWriter) {
      return Promise.reject(new Error("gbrain serve not started"));
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out`));
        }
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      writeMessage(childWriter, { jsonrpc: "2.0", id, method, params });
    });
  }

  async function doInitialize() {
    let lastErr = new Error("MCP initialize failed");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      try {
        const result = await sendRequest(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "joshu-gbrain-mcp-http", version: "1.0.0" },
          },
          30_000,
        );
        if (!result || typeof result !== "object") {
          throw new Error("MCP initialize returned empty result");
        }
        initResult = /** @type {Record<string, unknown>} */ (result);
        if (childWriter) {
          writeMessage(childWriter, { jsonrpc: "2.0", method: "notifications/initialized" });
        }
        ready = true;
        logLine(`gbrain MCP session ready (attempt ${attempt})`);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        logLine(`initialize attempt ${attempt}/3 failed: ${lastErr.message}`);
      }
    }
    throw lastErr;
  }

  async function ensureReady() {
    if (ready) return;
    if (!initPromise) {
      initPromise = doInitialize().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
  }

  async function listTools() {
    await ensureReady();
    const result = await sendRequest("tools/list", {});
    if (!result || typeof result !== "object") return [];
    const tools = /** @type {{ tools?: unknown[] }} */ (result).tools;
    return filterReadOnlyToolList(Array.isArray(tools) ? tools : []);
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   * @param {{ allowMutating?: boolean }} [opts]
   */
  async function callTool(name, args = {}, opts = {}) {
    if (!opts.allowMutating && !isReadOnlyGbrainTool(name)) {
      throw new Error(`Tool not allowed: ${name}`);
    }
    await ensureReady();
    const toolArgs =
      name === "query" || name === "search"
        ? normalizeGbrainQueryArgs(/** @type {Record<string, unknown>} */ (args))
        : args;
    const result = await sendRequest("tools/call", { name, arguments: toolArgs });
    return result;
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   */
  async function callToolText(name, args = {}) {
    const result = await callTool(name, args);
    return extractMcpToolText(result);
  }

  /** When true, next sync_brain uses full=true to drop orphan pages (e.g. after trash excludes). */
  let pendingFullSync = false;

  function queueSyncBrainCall() {
    if (!childWriter) return;
    const id = internalIdCounter++;
    internalRequestIds.add(id);
    const full = pendingFullSync;
    pendingFullSync = false;
    if (VERBOSE || full) logLine(`sync_brain repo=${SYNC_ROOT}${full ? " full=true" : ""}`);
    writeMessage(childWriter, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "sync_brain",
        // full: reconcile orphans when incremental last_commit skipped deletes
        // (common after ArozOS trash moves + sync blocked by a bad file).
        arguments: { repo: SYNC_ROOT, no_pull: true, ...(full ? { full: true } : {}) },
      },
    });
  }

  async function runReindexPipeline() {
    if (!childWriter) return;
    if (reindexInFlight) {
      pendingReindex = true;
      return;
    }
    if (!SYNC_ROOT) {
      logLine("JOSHU_DESKTOP_ROOT unset; skip sync_brain");
      return;
    }

    reindexInFlight = true;
    try {
      const stage = await stageDesktopForGbrainSync(SYNC_ROOT);
      if (stage.committed) {
        logLine(`desktop git commit before sync (${SYNC_ROOT})`);
      } else if (!stage.ok && stage.error) {
        logLine(`desktop git stage failed: ${stage.error}`);
      }
    } catch (err) {
      logLine(`desktop git stage failed: ${err instanceof Error ? err.message : err}`);
    }
    queueSyncBrainCall();
  }

  function scheduleReindex(delayMs = DEBOUNCE_MS) {
    if (reindexTimer) clearTimeout(reindexTimer);
    reindexTimer = setTimeout(() => {
      reindexTimer = null;
      void runReindexPipeline();
    }, delayMs);
  }

  function shouldWatchPath(filename) {
    if (!filename) return false;
    const lower = filename.replace(/\\/g, "/").toLowerCase();
    // Never react to ArozOS trash / git internals (noise + would re-index trash).
    if (
      lower === ".git" ||
      lower.startsWith(".git/") ||
      lower === ".metadata" ||
      lower.startsWith(".metadata/")
    ) {
      return false;
    }
    if (lower.endsWith(".shortcut")) return false;
    return lower.endsWith(".md") || lower.endsWith(".mdx");
  }

  /**
   * ArozOS "delete" is a rename into `.metadata/.trash/`. The recursive watcher
   * often only reports the folder name (`Appliances`) — not each `.md` — so an
   * extension-only filter would never schedule reindex and deleted folders stay
   * in File Brain until the next periodic tick.
   */
  function shouldWatchFsEvent(eventType, filename) {
    if (!filename) return eventType === "rename";
    const lower = filename.replace(/\\/g, "/").toLowerCase();
    if (
      lower === ".git" ||
      lower.startsWith(".git/") ||
      lower === ".metadata" ||
      lower.startsWith(".metadata/")
    ) {
      return false;
    }
    if (shouldWatchPath(filename)) return true;
    // Directory / non-markdown rename or delete (folder trash, move, remove).
    if (eventType === "rename") return true;
    return false;
  }

  function startFilesystemWatch() {
    if (!DESKTOP_ROOT) {
      logLine("JOSHU_DESKTOP_ROOT unset; fs watch disabled");
      return;
    }
    try {
      watch(DESKTOP_ROOT, { recursive: true }, (eventType, filename) => {
        if (!shouldWatchFsEvent(eventType, filename || "")) return;
        // Folder trash / rename: prefer full sync so orphan pages drop promptly.
        if (eventType === "rename" && filename && !shouldWatchPath(filename)) {
          pendingFullSync = true;
        }
        scheduleReindex();
      });
      logLine(`watching ${DESKTOP_ROOT} (debounce ${DEBOUNCE_MS}ms)`);
    } catch (err) {
      logLine(`fs watch failed: ${err instanceof Error ? err.message : err}`);
    }

    if (REINDEX_TOUCH) {
      try {
        watch(path.dirname(REINDEX_TOUCH), (_event, name) => {
          if (name === path.basename(REINDEX_TOUCH)) scheduleReindex(200);
          if (FULL_SYNC_TOUCH && name === path.basename(FULL_SYNC_TOUCH)) {
            pendingFullSync = true;
            logLine("full sync requested via .joshu-full-sync-touch");
            scheduleReindex(200);
          }
        });
      } catch {
        /* optional */
      }
    }
  }

  function startPeriodicReindex() {
    if (REINDEX_INTERVAL_SEC <= 0) {
      logLine("periodic reindex disabled (GBRAIN_REINDEX_INTERVAL_SEC=0)");
      return;
    }
    setInterval(() => {
      if (VERBOSE) logLine(`periodic reindex tick (${REINDEX_INTERVAL_SEC}s)`);
      void runReindexPipeline();
    }, REINDEX_INTERVAL_SEC * 1000);
    logLine(`periodic reindex every ${REINDEX_INTERVAL_SEC}s`);
  }

  async function probeIndexedPageCount() {
    if (!ready) return -1;
    try {
      const text = await callToolText("get_recent_salience", { limit: 10, days: 3650 });
      return parseMcpListPageCount(text);
    } catch {
      return -1;
    }
  }

  async function verifyIndexAfterSync() {
    if (!EMPTY_INDEX_CHECK || !DESKTOP_ROOT) return;
    try {
      const diskMarkdown = await countIndexableMarkdown(DESKTOP_ROOT, { minCount: 1 });
      if (diskMarkdown < 1) {
        emptyIndexStreak = 0;
        return;
      }
      const indexedPages = await probeIndexedPageCount();
      if (indexedPages > 0) {
        emptyIndexStreak = 0;
        return;
      }
      emptyIndexStreak += 1;
      logLine(
        `empty index after sync (${emptyIndexStreak}): disk has ${diskMarkdown}+ markdown but 0 indexed pages`,
      );
      if (emptyIndexStreak < 3) {
        pendingFullSync = true;
        scheduleReindex(5000);
        return;
      }
      if (FULL_SYNC_FLAG) {
        try {
          appendFileSync(FULL_SYNC_FLAG, `${new Date().toISOString()} empty index\n`);
        } catch {
          /* ignore */
        }
      }
      logLine("empty index persists — flagged for ensure-gbrain-indexed.sh full recovery");
    } catch (err) {
      logLine(`empty index check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  function startEmptyIndexWatchdog() {
    if (!EMPTY_INDEX_CHECK || !DESKTOP_ROOT) {
      logLine("empty-index watchdog disabled (no DESKTOP_ROOT or GBRAIN_EMPTY_INDEX_CHECK=0)");
      return;
    }
    setInterval(async () => {
      try {
        const report = await assessGbrainIndexHealth({
          desktopRoot: DESKTOP_ROOT,
          mcpBaseUrl: MCP_HTTP_URL,
        });
        if (!report.needsRecovery) {
          emptyIndexStreak = 0;
          return;
        }
        logLine(
          `empty-index watchdog: disk=${report.diskMarkdown} indexed=${report.indexedPages} — scheduling full sync_brain`,
        );
        pendingFullSync = true;
        scheduleReindex(500);
        if (emptyIndexStreak >= 2 && FULL_SYNC_FLAG) {
          try {
            appendFileSync(FULL_SYNC_FLAG, `${new Date().toISOString()} watchdog\n`);
          } catch {
            /* ignore */
          }
        }
        emptyIndexStreak += 1;
      } catch (err) {
        logLine(`empty-index watchdog error: ${err instanceof Error ? err.message : err}`);
      }
    }, EMPTY_INDEX_CHECK_SEC * 1000);
    logLine(`empty-index watchdog every ${EMPTY_INDEX_CHECK_SEC}s`);
  }

  function rejectAllPending(reason) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
    internalRequestIds.clear();
    reindexInFlight = false;
    pendingReindex = false;
  }

  function scheduleServeRespawn(code, signal) {
    logLine(`gbrain serve exited code=${code ?? "?"} signal=${signal ?? ""}; respawn in ${serveRespawnDelayMs}ms`);
    ready = false;
    initResult = null;
    initPromise = null;
    childWriter = null;
    child = null;
    rejectAllPending("gbrain serve exited");

    setTimeout(() => {
      try {
        startGbrainServeChild();
      } catch (err) {
        logLine(`gbrain serve respawn failed: ${err instanceof Error ? err.message : err}`);
        scheduleServeRespawn(1, "");
      }
    }, serveRespawnDelayMs);
    serveRespawnDelayMs = Math.min(serveRespawnDelayMs * 2, SERVE_RESPAWN_MAX_MS);
  }

  function startGbrainServeChild() {
    const childEnv = { ...process.env, MCP_STDIO: "1" };
    delete childEnv.DATABASE_URL;
    delete childEnv.GBRAIN_DATABASE_URL;

    child = spawn(GBRAIN_BIN, ["serve"], {
      env: childEnv,
      stdio: ["pipe", "pipe", "inherit"],
    });

    if (!child.stdin || !child.stdout) {
      throw new Error("failed to spawn gbrain serve");
    }

    childWriter = child.stdin;
    createMcpReader(child.stdout, handleChildMessage);

    child.once("spawn", () => {
      serveRespawnDelayMs = 2000;
      void doInitialize().catch((err) => {
        logLine(`post-spawn initialize failed: ${err instanceof Error ? err.message : err}`);
      });
    });

    child.on("exit", (code, signal) => {
      scheduleServeRespawn(code, signal);
    });
  }

  function spawnGbrainServe() {
    startGbrainServeChild();
  }

  function getActivityStatus() {
    return {
      reindex_running: reindexInFlight,
      reindex_scheduled: reindexTimer != null,
      reindex_pending: pendingReindex,
      active: reindexInFlight || reindexTimer != null || pendingReindex,
    };
  }

  return {
    spawnGbrainServe,
    startFilesystemWatch,
    startPeriodicReindex,
    startEmptyIndexWatchdog,
    scheduleReindex,
    ensureReady,
    listTools,
    callTool,
    callToolText,
    getInitResult: () => initResult,
    isReady: () => ready,
    getActivityStatus,
  };
}
