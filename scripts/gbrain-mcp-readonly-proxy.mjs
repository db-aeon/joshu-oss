#!/usr/bin/env node
/**
 * @deprecated Replaced by scripts/gbrain-mcp-http-server.mjs (Joshu-supervised HTTP MCP).
 * Legacy stdio proxy for Hermes — kept for reference only.
 *
 * Hermes spawns this instead of `gbrain serve` directly. It forwards stdio MCP to a
 * child `gbrain serve` process, filters tools/list and blocks mutating tools/call,
 * and runs sync_brain inside the child when files change under JOSHU_FILES_ROOT.
 *
 * Env: GBRAIN_BIN, GBRAIN_HOME, JOSHU_FILES_ROOT, GBRAIN_REINDEX_DEBOUNCE_MS, MCP_STDIO=1
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterReadOnlyToolList,
  isReadOnlyGbrainTool,
} from "./lib/gbrain-mcp-readonly.mjs";
import { normalizeGbrainQueryArgs } from "./lib/gbrain-query-args.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GBRAIN_BIN = process.env.GBRAIN_BIN?.trim() || "gbrain";
const GBRAIN_HOME = process.env.GBRAIN_HOME?.trim();
const FILES_ROOT = process.env.JOSHU_FILES_ROOT?.trim();
const DEBOUNCE_MS = Math.max(
  500,
  Number.parseInt(process.env.GBRAIN_REINDEX_DEBOUNCE_MS || "3000", 10) || 3000,
);
const LOG_FILE = process.env.GBRAIN_LOG_FILE?.trim();
const REINDEX_TOUCH = GBRAIN_HOME
  ? path.join(GBRAIN_HOME, ".joshu-reindex-touch")
  : undefined;

/** Parent (Hermes) request ids — only these responses are forwarded from child. */
const parentRequestIds = new Set();
/** Internal sync_brain calls — responses consumed by proxy. */
const internalRequestIds = new Set();
let internalIdCounter = 900_000;
let reindexTimer = null;
let reindexInFlight = false;
let pendingReindex = false;

function log(msg) {
  const line = `[gbrain-mcp-proxy] ${msg}\n`;
  process.stderr.write(line);
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, line);
    } catch {
      /* ignore */
    }
  }
}

function writeMessage(stream, obj) {
  const body = JSON.stringify(obj);
  const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  if (stream === process.stdout) {
    const ok = stream.write(payload);
    if (!ok) {
      log(`parent stdout backpressure; dropped MCP response id=${String(obj.id ?? "(none)")}`);
    }
    return;
  }
  stream.write(payload);
}

/** @param {import('node:stream').Readable} stream */
function createMcpReader(stream, onMessage) {
  let buffer = Buffer.alloc(0);

  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;

      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);

      try {
        onMessage(JSON.parse(body));
      } catch (err) {
        log(`invalid JSON from stream: ${err instanceof Error ? err.message : err}`);
      }
    }
  });
}

/**
 * @param {Record<string, unknown>} msg
 * @param {'parent' | 'child'} direction
 */
function handleParentToChild(msg, childWriter) {
  const id = msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";

  if (method === "tools/call") {
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    const toolName =
      typeof /** @type {{ name?: string }} */ (params).name === "string"
        ? /** @type {{ name?: string }} */ (params).name
        : "";
    if (!isReadOnlyGbrainTool(toolName)) {
      log(`blocked mutating tool: ${toolName || "(unknown)"}`);
      if (id !== undefined && id !== null) {
        writeMessage(process.stdout, {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Tool '${toolName}' is not available. Write files with Hermes filesystem tools under JOSHU_FILES_ROOT; gbrain MCP is read-only in Joshu.`,
          },
        });
      }
      return;
    }
    if (toolName === "query" || toolName === "search") {
      const args =
        params.arguments && typeof params.arguments === "object"
          ? /** @type {Record<string, unknown>} */ (params.arguments)
          : {};
      msg = {
        ...msg,
        params: { ...params, arguments: normalizeGbrainQueryArgs(args) },
      };
    }
  }

  if (id !== undefined && id !== null) {
    parentRequestIds.add(id);
  }

  writeMessage(childWriter, msg);
}

/**
 * @param {Record<string, unknown>} msg
 * @param {ReturnType<typeof createGbrainMcpInspect>} [inspect]
 */
function handleChildToParent(msg) {
  const id = msg.id;

  if (id !== undefined && id !== null && internalRequestIds.has(id)) {
    internalRequestIds.delete(id);
    if (msg.error) {
      log(`sync_brain failed: ${JSON.stringify(msg.error)}`);
    } else {
      log("sync_brain completed");
    }
    if (pendingReindex) {
      pendingReindex = false;
      scheduleReindex(100);
    }
    reindexInFlight = false;
    return;
  }

  if (id !== undefined && id !== null && !parentRequestIds.has(id)) {
    return;
  }

  if (id !== undefined && id !== null) {
    parentRequestIds.delete(id);
  }

  const result = msg.result;
  if (
    result &&
    typeof result === "object" &&
    ("protocolVersion" in result || "serverInfo" in result)
  ) {
    /* init response */
  }
  if (result && typeof result === "object" && Array.isArray(result.tools)) {
    msg.result = {
      ...result,
      tools: filterReadOnlyToolList(result.tools),
    };
  }

  writeMessage(process.stdout, msg);
}

/** @param {import('node:stream').Writable} childWriter */
function queueSyncBrain(childWriter) {
  if (reindexInFlight) {
    pendingReindex = true;
    return;
  }
  if (!FILES_ROOT) {
    log("JOSHU_FILES_ROOT unset; skip sync_brain");
    return;
  }

  reindexInFlight = true;
  const id = internalIdCounter++;
  internalRequestIds.add(id);

  log(`sync_brain repo=${FILES_ROOT}`);
  writeMessage(childWriter, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "sync_brain",
      arguments: {
        repo: FILES_ROOT,
        no_pull: true,
      },
    },
  });
}

/** @param {import('node:stream').Writable} childWriter */
function scheduleReindex(delayMs = DEBOUNCE_MS) {
  if (reindexTimer) clearTimeout(reindexTimer);
  reindexTimer = setTimeout(() => {
    reindexTimer = null;
    queueSyncBrain(childWriter);
  }, delayMs);
}

function shouldWatchPath(filename) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return true;
  return false;
}

/** @param {import('node:stream').Writable} childWriter */
function startFilesystemWatch(childWriter) {
  if (!FILES_ROOT) {
    log("JOSHU_FILES_ROOT unset; fs watch disabled");
    return;
  }

  try {
    watch(FILES_ROOT, { recursive: true }, (_event, filename) => {
      if (filename && !shouldWatchPath(filename)) return;
      scheduleReindex();
    });
    log(`watching ${FILES_ROOT} (debounce ${DEBOUNCE_MS}ms)`);
  } catch (err) {
    log(`fs watch failed: ${err instanceof Error ? err.message : err}`);
  }

  if (REINDEX_TOUCH) {
    try {
      watch(path.dirname(REINDEX_TOUCH), (_event, name) => {
        if (name === path.basename(REINDEX_TOUCH)) scheduleReindex(200);
      });
    } catch {
      /* optional */
    }
  }
}

function main() {
  const childEnv = { ...process.env, MCP_STDIO: "1" };
  delete childEnv.DATABASE_URL;
  delete childEnv.GBRAIN_DATABASE_URL;

  const child = spawn(GBRAIN_BIN, ["serve"], {
    env: childEnv,
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (!child.stdin || !child.stdout) {
    log("failed to spawn gbrain serve");
    process.exit(1);
  }

  const childWriter = child.stdin;

  createMcpReader(process.stdin, (msg) => handleParentToChild(msg, childWriter));
  createMcpReader(child.stdout, (msg) => handleChildToParent(msg));

  child.on("exit", (code, signal) => {
    log(`gbrain serve exited code=${code ?? "?"} signal=${signal ?? ""}`);
    process.exit(code ?? 1);
  });

  startFilesystemWatch(childWriter);
}

main();
