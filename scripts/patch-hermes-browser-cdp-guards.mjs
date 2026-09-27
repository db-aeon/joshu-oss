#!/usr/bin/env node
/**
 * Patch Hermes tools/browser_tool.py so the built-in CDP/local browser tools
 * honor Joshu's handoff lock and browser write gate, and self-heal the shared
 * cloud browser.
 *
 * - Handoff lock + action guard: inserted after the Camofox early-return, so
 *   Camofox mode keeps using the browser_camofox.py patches and is not checked
 *   twice.
 * - Cloud ensure (`joshu_cloud_browser_ensure`): at the start of every
 *   browser_* entrypoint, POST /api/browser/ensure. Joshu wakes/recreates the
 *   Browser Use session and returns its live CDP URL; the helper adopts it
 *   (BROWSER_CDP_URL beats config.yaml in Hermes) and drops cached sessions
 *   bound to the dead browser. When the browser cannot start, the tool returns
 *   `browser_unavailable` instead of a raw CDP 502, so workers block the task
 *   rather than debugging the box.
 *
 * Idempotent. Upgrades files patched by older versions (lock only, or lock +
 * the old fire-and-forget `/api/browser/touch` helper).
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-browser-cdp-guards.mjs <path/to/browser_tool.py>");
  process.exit(1);
}

const MARKER = "hitl_browser_cdp_guards";
const ENSURE_MARKER = "joshu_cloud_browser_ensure";
/** Name kept from the old touch helper so already-patched call sites stay valid during upgrade. */
const ENSURE_FN = "_joshu_cloud_browser_touch";

/** Every browser_* tool that talks to the page (and so needs a live browser). */
const ENSURE_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_back",
  "browser_press",
  "browser_console",
  "browser_get_images",
  "browser_vision",
];

const lockHelpers = `
def _joshu_browser_cdp_base() -> str:
    return (
        os.getenv("JOSHU_CONNECTORS_API_BASE", "http://127.0.0.1:8788/joshu")
        .strip()
        .rstrip("/")
    )


def _joshu_browser_handoff_lock_check() -> Optional[str]:
    """Return a tool_error JSON string when owner mobile handoff holds the browser lock (${MARKER})."""
    base = _joshu_browser_cdp_base()
    try:
        resp = requests.get(f"{base}/api/browser-handoff/lock", timeout=10)
        payload = resp.json() if resp.content else {}
    except Exception as exc:
        logger.warning("Joshu browser handoff lock check failed: %s", exc)
        return None
    if resp.status_code >= 400:
        logger.warning("Joshu browser handoff lock HTTP %s: %s", resp.status_code, payload)
        return None
    if not payload.get("locked"):
        return None
    stub = {
        "success": False,
        "error": "browser_handoff_locked",
        "message": (
            "Browser is locked for owner mobile handoff. "
            "Wait for browser_handoff_status=completed before navigating or clicking."
        ),
        "handoffId": payload.get("handoffId"),
        "pageUrl": payload.get("pageUrl"),
        "instructions": payload.get("instructions"),
    }
    return json.dumps(stub)


def _joshu_browser_guard_enabled() -> bool:
    return os.getenv("JOSHU_ACTION_GUARD_BROWSER_GATE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _joshu_action_guard_browser(kind: str, args: Dict[str, Any]) -> Optional[str]:
    """Return a tool_error JSON string when the owner denied or timed out (${MARKER})."""
    if not _joshu_browser_guard_enabled():
        return None
    base = _joshu_browser_cdp_base()
    try:
        resp = requests.post(
            f"{base}/api/action-guard/browser",
            json={"kind": kind, "args": args},
            timeout=60 * 30,
        )
        payload = resp.json() if resp.content else {}
    except Exception as exc:
        logger.warning("Joshu browser action guard failed: %s", exc)
        return None
    if resp.status_code >= 400:
        logger.warning("Joshu browser action guard HTTP %s: %s", resp.status_code, payload)
        return None
    if payload.get("allowed") is True:
        return None
    stub = payload.get("stub")
    if isinstance(stub, dict):
        return json.dumps(stub)
    return json.dumps({"success": True})
`;

// Upstream browser_tool.py imports requests lazily inside functions only; the
// Joshu helpers use the module-level name (a missing import silently disabled
// the handoff lock: NameError was swallowed by `except Exception`).
const ensureBlock = `
try:
    import requests  # Joshu browser helpers (${MARKER} / ${ENSURE_MARKER})
except Exception:  # pragma: no cover - requests ships with Hermes
    requests = None


_JOSHU_BROWSER_UNAVAILABLE = {
    "success": False,
    "error": "browser_unavailable",
    "message": (
        "The shared browser could not start. This is a system problem, not a task problem: "
        "do not debug the box, read or change Hermes config, curl local services, or switch "
        "to another browser path. Retry this tool once; if it fails again, "
        "kanban_block with reason 'system: browser unavailable'."
    ),
}


def ${ENSURE_FN}() -> Optional[str]:
    """Wake the shared cloud browser and adopt its live CDP URL (${ENSURE_MARKER}).

    Joshu's /api/browser/ensure re-provisions a Browser Use session that idled
    out and returns its CDP URL. BROWSER_CDP_URL beats browser.cdp_url in
    _get_cdp_override_raw(), so long-lived gateway/worker processes must refresh
    it here or keep dialing the dead browser (CDP 502). Returns a tool-error
    JSON string when the browser cannot start; None otherwise (local backends
    return an empty cdpUrl and are left alone).
    """
    if requests is None:
        return None
    base = (
        os.getenv("JOSHU_CONNECTORS_API_BASE", "http://127.0.0.1:8788/joshu")
        .strip()
        .rstrip("/")
    )
    try:
        resp = requests.post(f"{base}/api/browser/ensure", timeout=60)
    except Exception as exc:
        logger.warning("Joshu browser ensure failed: %s", exc)
        return None
    if resp.status_code == 404:
        # Older Joshu stack without /ensure: keep the idle-timer touch.
        try:
            requests.post(f"{base}/api/browser/touch", timeout=2)
        except Exception:
            pass
        return None
    try:
        payload = resp.json() if resp.content else {}
    except ValueError:
        payload = {}
    if payload.get("error") == "browser_unavailable":
        return json.dumps(_JOSHU_BROWSER_UNAVAILABLE)
    if resp.status_code >= 400:
        logger.warning("Joshu browser ensure HTTP %s", resp.status_code)
        return None
    cdp_url = str(payload.get("cdpUrl") or "").strip()
    if cdp_url and cdp_url != os.environ.get("BROWSER_CDP_URL", "").strip():
        os.environ["BROWSER_CDP_URL"] = cdp_url
        _joshu_drop_stale_cdp_sessions(cdp_url)
        logger.info("Joshu cloud browser rotated; adopted new CDP endpoint")
    return None


def _joshu_drop_stale_cdp_sessions(cdp_url: str) -> None:
    """Forget cached CDP sessions bound to a previous cloud browser (${ENSURE_MARKER})."""
    from urllib.parse import urlparse

    def _host(url: Any) -> str:
        try:
            return (urlparse(str(url or "")).hostname or "").lower()
        except Exception:
            return ""

    new_host = _host(cdp_url)
    with _cleanup_lock:
        stale = [
            key
            for key, info in _active_sessions.items()
            if (info.get("features") or {}).get("cdp_override") and _host(info.get("cdp_url")) != new_host
        ]
        for key in stale:
            # The old browser is gone or being replaced: mark expired so cleanup
            # skips the agent-browser close round trip against it.
            _active_sessions[key]["expires_at"] = 0
    for key in stale:
        try:
            _cleanup_single_browser_session(key)
        except Exception as exc:
            logger.warning("Joshu stale CDP session cleanup failed for %s: %s", key, exc)
`;

const ensureCall = `    _joshu_ensure_err = ${ENSURE_FN}()
    if _joshu_ensure_err:
        return _joshu_ensure_err
`;
/** Bare statement from the old touch patch (the ensure call assigns its result, so never matches). */
const LEGACY_TOUCH_CALL_RE = new RegExp(`^    ${ENSURE_FN}\\(\\)\\n`, "gm");

const lockNeedle = `    lock_err = _joshu_browser_handoff_lock_check()
    if lock_err:
        return lock_err
`;

function guardNeedle(kind, argBuilder) {
  return `    guard_err = _joshu_action_guard_browser("${kind}", ${argBuilder})
    if guard_err:
        return guard_err
`;
}

function fail(message) {
  console.error(`[hermes-patch] ${message} in ${target}`);
  process.exit(1);
}

/** Offset just past a (possibly multi-line) `def ...(...) -> T:` signature. */
function signatureEnd(source, fnStart) {
  const sig = /\)\s*(?:->[^\n]*)?:[ \t]*\n/g;
  sig.lastIndex = fnStart;
  const sigMatch = sig.exec(source);
  return sigMatch ? sigMatch.index + sigMatch[0].length : -1;
}

/**
 * [start, end) of a top-level function. The body ends at the first non-blank
 * line that starts in column 0 (next def, decorator, module statement) — not
 * at the next `def`, so module-level code between functions is never swallowed.
 */
function functionSpan(source, fnName) {
  const found = source.indexOf(`\ndef ${fnName}(`);
  if (found < 0) return null;
  const fnStart = found + 1;
  const bodyStart = signatureEnd(source, fnStart);
  if (bodyStart < 0) return null;
  const topLevel = /^[^\s#]/gm;
  topLevel.lastIndex = bodyStart;
  const next = topLevel.exec(source);
  return [fnStart, next ? next.index : source.length];
}

/**
 * Offset of the first body statement: after the signature and the docstring,
 * so the docstring stays the function's __doc__.
 */
function bodyInsertOffset(source, fnStart) {
  const offset = signatureEnd(source, fnStart);
  if (offset < 0) return -1;
  const firstLine = source.slice(offset, source.indexOf("\n", offset) + 1);
  const quote = firstLine.trim().startsWith('"""') ? '"""' : firstLine.trim().startsWith("'''") ? "'''" : "";
  if (!quote) return offset;
  const openAt = source.indexOf(quote, offset);
  const closeAt = source.indexOf(quote, openAt + 3);
  if (closeAt < 0) return -1;
  return source.indexOf("\n", closeAt) + 1;
}

function insertEnsureCall(source, fnName) {
  const span = functionSpan(source, fnName);
  if (!span) fail(`${fnName}() not found`);
  const body = source.slice(span[0], span[1]);
  if (body.includes(`_joshu_ensure_err = ${ENSURE_FN}()`)) return source;
  const at = bodyInsertOffset(source, span[0]);
  if (at < 0 || at > span[1]) fail(`${fnName}() body start not found`);
  return source.slice(0, at) + ensureCall + source.slice(at);
}

function insertAfterCamofoxReturn(source, fnName, callee, insertion) {
  const span = functionSpan(source, fnName);
  if (!span) fail(`${fnName}() not found`);
  const fnBody = source.slice(span[0], span[1]);
  if (fnBody.includes("_joshu_browser_handoff_lock_check()")) return source;
  const ret = fnBody.indexOf(`return ${callee}(`);
  if (ret < 0) fail(`${callee}() return not found in ${fnName}()`);
  const abs = span[0] + fnBody.indexOf("\n", ret) + 1;
  return source.slice(0, abs) + insertion + source.slice(abs);
}

let source = readFileSync(target, "utf8");
const original = source;

const loggerAnchor = "logger = logging.getLogger(__name__)";
if (!source.includes(loggerAnchor)) fail("logger anchor not found");

// 1. Helpers: lock/guard (once), then the ensure block (replacing the old touch helper).
if (!source.includes("def _joshu_browser_handoff_lock_check(")) {
  source = source.replace(loggerAnchor, `${loggerAnchor}\n${lockHelpers}`);
}
if (!source.includes(ENSURE_MARKER)) {
  const legacy = functionSpan(source, ENSURE_FN);
  if (legacy) {
    source = source.slice(0, legacy[0]) + ensureBlock.trimStart() + "\n\n" + source.slice(legacy[1]);
  } else {
    // After the lock helpers when present, else right after the logger.
    const anchorFn = functionSpan(source, "_joshu_action_guard_browser");
    const at = anchorFn ? anchorFn[1] : source.indexOf(loggerAnchor) + loggerAnchor.length + 1;
    source = source.slice(0, at) + ensureBlock + "\n" + source.slice(at);
  }
}

// 2. Old fire-and-forget call sites were inserted right after the `def` line
//    (inside multi-line signatures on some Hermes versions): drop them, then
//    insert ensure calls after each signature + docstring.
source = source.replace(LEGACY_TOUCH_CALL_RE, "");
for (const fnName of ENSURE_TOOLS) {
  source = insertEnsureCall(source, fnName);
}

// 3. Handoff lock + write gate after the Camofox early-returns.
source = insertAfterCamofoxReturn(source, "browser_navigate", "camofox_navigate", lockNeedle);
source = insertAfterCamofoxReturn(
  source,
  "browser_click",
  "camofox_click",
  lockNeedle + guardNeedle("click", '{"ref": ref, "url": ""}'),
);
source = insertAfterCamofoxReturn(
  source,
  "browser_type",
  "camofox_type",
  lockNeedle + guardNeedle("type", '{"ref": ref, "text": text}'),
);
source = insertAfterCamofoxReturn(source, "browser_back", "camofox_back", lockNeedle);
source = insertAfterCamofoxReturn(
  source,
  "browser_press",
  "camofox_press",
  lockNeedle + guardNeedle("press", '{"key": key}'),
);

if (source === original) {
  console.log("[hermes-patch] CDP browser handoff lock + cloud ensure already applied.");
  process.exit(0);
}
writeFileSync(target, source);
console.log("[hermes-patch] applied CDP browser handoff lock + cloud ensure — restart Hermes gateway");
