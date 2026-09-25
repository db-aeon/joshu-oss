#!/usr/bin/env node
/**
 * Self-contained tests for the Hermes tool patches (no hermes-agent checkout):
 *
 * - patch-hermes-browser-cdp-guards.mjs on a synthetic browser_tool.py:
 *   fresh apply, idempotency, upgrade from the old touch patch (which inserted
 *   calls inside multi-line signatures), and runtime cloud-ensure behavior with
 *   a stubbed `requests` (URL adoption, stale session drop, browser_unavailable).
 * - patch-hermes-terminal-secrets-guard.mjs: Hermes config writes blocked,
 *   reads allowed.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const browserPatch = path.join(root, "scripts/patch-hermes-browser-cdp-guards.mjs");
const terminalPatch = path.join(root, "scripts/patch-hermes-terminal-secrets-guard.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-hermes-patches-"));

function runPatch(script, file) {
  return execFileSync("node", [script, file], { encoding: "utf8" });
}

function python(code, cwd = tmp) {
  const r = spawnSync("python3", ["-c", code], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function pyCompiles(file) {
  return spawnSync("python3", ["-m", "py_compile", file], { encoding: "utf8" }).status === 0;
}

// Minimal stand-in with the shapes the patch relies on: logger anchor, Camofox
// early returns, a multi-line signature + docstring, module code between defs.
const browserFixture = `import json
import logging
import os
import threading
from typing import Dict, Any, Optional, Union

logger = logging.getLogger(__name__)

_cleanup_lock = threading.Lock()
_active_sessions: Dict[str, Dict[str, Any]] = {}
CLEANED = []


def _is_camofox_mode() -> bool:
    return False


def _cleanup_single_browser_session(task_id: str) -> None:
    CLEANED.append((task_id, _active_sessions[task_id].get("expires_at")))
    with _cleanup_lock:
        _active_sessions.pop(task_id, None)


def camofox_navigate(url, task_id=None): return "camofox"
def camofox_click(ref, task_id=None): return "camofox"
def camofox_type(ref, text, task_id=None): return "camofox"
def camofox_back(task_id=None): return "camofox"
def camofox_press(key, task_id=None): return "camofox"


def browser_navigate(url: str, task_id: Optional[str] = None) -> str:
    """Navigate to a URL."""
    if _is_camofox_mode():
        return camofox_navigate(url, task_id)
    return json.dumps({"success": True, "cdp": os.environ.get("BROWSER_CDP_URL", "")})


MODULE_SENTINEL = "kept"


def browser_snapshot(
    full: bool = False,
    task_id: Optional[str] = None,
) -> str:
    """
    Snapshot of the page.
    """
    return json.dumps({"success": True})


def browser_click(ref: str, task_id: Optional[str] = None) -> str:
    """Click."""
    if _is_camofox_mode():
        return camofox_click(ref, task_id)
    return json.dumps({"success": True})


def browser_type(ref: str, text: str, task_id: Optional[str] = None) -> str:
    """Type."""
    if _is_camofox_mode():
        return camofox_type(ref, text, task_id)
    return json.dumps({"success": True})


def browser_scroll(direction: str, task_id: Optional[str] = None) -> str:
    """Scroll."""
    return json.dumps({"success": True})


def browser_back(task_id: Optional[str] = None) -> str:
    """Back."""
    if _is_camofox_mode():
        return camofox_back(task_id)
    return json.dumps({"success": True})


def browser_press(key: str, task_id: Optional[str] = None) -> str:
    """Press."""
    if _is_camofox_mode():
        return camofox_press(key, task_id)
    return json.dumps({"success": True})


def browser_console(clear: bool = False, expression: Optional[str] = None, task_id: Optional[str] = None) -> str:
    """Console."""
    return json.dumps({"success": True})


def browser_get_images(task_id: Optional[str] = None) -> str:
    """Images."""
    return json.dumps({"success": True})


def browser_vision(question: str, annotate: bool = False, task_id: Optional[str] = None) -> Union[str, Dict[str, Any]]:
    """Vision."""
    return json.dumps({"success": True})
`;

// --- Fresh apply + idempotency ---
const fresh = path.join(tmp, "browser_tool.py");
fs.writeFileSync(fresh, browserFixture);
assert.match(runPatch(browserPatch, fresh), /applied/);
const once = fs.readFileSync(fresh, "utf8");
assert.match(runPatch(browserPatch, fresh), /already applied/);
assert.equal(fs.readFileSync(fresh, "utf8"), once, "second run must not change the file");
assert.ok(pyCompiles(fresh), "patched fixture compiles");
assert.equal((once.match(/_joshu_ensure_err = _joshu_cloud_browser_touch\(\)/g) || []).length, 10);
assert.equal((once.match(/lock_err = _joshu_browser_handoff_lock_check\(\)/g) || []).length, 5);
assert.ok(once.includes('MODULE_SENTINEL = "kept"'));
assert.ok(
  once.indexOf('Snapshot of the page.\n    """\n    _joshu_ensure_err') > 0,
  "ensure call goes after the multi-line signature and docstring",
);

// --- Upgrade from the old touch patch (bare call right after the def line) ---
const legacy = path.join(tmp, "legacy_browser_tool.py");
let legacySource = browserFixture.replace(
  "logger = logging.getLogger(__name__)\n",
  `logger = logging.getLogger(__name__)

def _joshu_cloud_browser_touch() -> None:
    """Reset Joshu cloud browser idle timer after Hermes browser_* tool use (joshu_cloud_browser_touch)."""
    try:
        requests.post("http://127.0.0.1:8788/joshu/api/browser/touch", timeout=2)
    except Exception:
        pass

LEGACY_SENTINEL = 1
`,
);
for (const fn of ["browser_navigate", "browser_snapshot", "browser_click"]) {
  const at = legacySource.indexOf(`\ndef ${fn}(`) + 1;
  const lineEnd = legacySource.indexOf("\n", at) + 1;
  legacySource = legacySource.slice(0, lineEnd) + "    _joshu_cloud_browser_touch()\n" + legacySource.slice(lineEnd);
}
fs.writeFileSync(legacy, legacySource);
assert.equal(pyCompiles(legacy), false, "old touch patch broke multi-line signatures");
runPatch(browserPatch, legacy);
const upgraded = fs.readFileSync(legacy, "utf8");
assert.ok(pyCompiles(legacy), "upgrade repairs the file");
assert.equal((upgraded.match(/^    _joshu_cloud_browser_touch\(\)$/gm) || []).length, 0);
assert.equal((upgraded.match(/^def _joshu_cloud_browser_touch/gm) || []).length, 1);
assert.ok(upgraded.includes("joshu_cloud_browser_ensure"));
assert.ok(upgraded.includes("LEGACY_SENTINEL = 1"), "module code after the old helper survives");
assert.match(runPatch(browserPatch, legacy), /already applied/);

// --- Runtime: ensure adopts rotated CDP URLs and surfaces browser_unavailable ---
const runtime = python(`
import json, os, sys, types

state = {"ensure": None, "touch": 0}

class Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.content = b"x" if body is not None else b""
    def json(self):
        return self._body

def post(url, **kw):
    if url.endswith("/api/browser/ensure"):
        return Resp(*state["ensure"])
    if url.endswith("/api/browser/touch"):
        state["touch"] += 1
        return Resp(200, {"ok": True})
    raise AssertionError(url)

def get(url, **kw):
    return Resp(200, {"locked": False})

sys.modules["requests"] = types.SimpleNamespace(post=post, get=get)
sys.path.insert(0, ".")
os.environ["BROWSER_CDP_URL"] = "https://old.cdp.browser-use.com"
import browser_tool as bt

bt._active_sessions["t1"] = {"cdp_url": "wss://old.cdp.browser-use.com/devtools/browser/x", "features": {"cdp_override": True}}
bt._active_sessions["local"] = {"cdp_url": "", "features": {}}

state["ensure"] = (200, {"ok": True, "backend": "cloud", "cdpUrl": "https://new.cdp.browser-use.com"})
nav = json.loads(bt.browser_navigate("https://example.com", task_id="t1"))
out = {"nav": nav, "env": os.environ["BROWSER_CDP_URL"], "cleaned": bt.CLEANED, "left": sorted(bt._active_sessions)}

state["ensure"] = (502, {"ok": False, "backend": "cloud", "error": "browser_unavailable"})
out["down"] = json.loads(bt.browser_console())

state["ensure"] = (404, None)
out["old_stack"] = json.loads(bt.browser_snapshot())
out["touch"] = state["touch"]

state["ensure"] = (200, {"ok": True, "backend": "local", "cdpUrl": ""})
out["local_env"] = json.loads(bt.browser_scroll("down")) and os.environ["BROWSER_CDP_URL"]
print(json.dumps(out))
`, tmp);
const r = JSON.parse(runtime.trim().split("\n").pop());
assert.equal(r.nav.success, true);
assert.equal(r.nav.cdp, "https://new.cdp.browser-use.com", "navigate sees the adopted URL");
assert.equal(r.env, "https://new.cdp.browser-use.com");
assert.deepEqual(r.cleaned, [["t1", 0]], "only the stale CDP session is dropped, marked expired");
assert.deepEqual(r.left, ["local"]);
assert.equal(r.down.error, "browser_unavailable");
assert.match(r.down.message, /kanban_block/);
assert.equal(r.old_stack.success, true, "older Joshu stack without /ensure still works");
assert.equal(r.touch, 1, "falls back to the idle touch");
assert.equal(r.local_env, "https://new.cdp.browser-use.com", "local backend leaves the env alone");

// --- Terminal guard: Hermes config writes blocked, reads allowed ---
const terminal = path.join(tmp, "terminal_tool.py");
fs.writeFileSync(
  terminal,
  `import json
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)


def _safe_command_preview(command):
    return command[:80]


def terminal_tool(command: str) -> str:
    if True:
        # Pre-exec security checks (tirith + dangerous command detection)
        return json.dumps({"output": "ran", "exit_code": 0})
`,
);
runPatch(terminalPatch, terminal);
const terminalOnce = fs.readFileSync(terminal, "utf8");
runPatch(terminalPatch, terminal);
assert.equal(fs.readFileSync(terminal, "utf8"), terminalOnce, "terminal guard is idempotent");
const verdicts = JSON.parse(
  python(`
import json, sys
sys.path.insert(0, ".")
import terminal_tool as tt
cases = [
    '/opt/hermes-agent/venv/bin/hermes config set browser.cdp_url "https://x"',
    "hermes config edit",
    "sed -i 's/a/b/' /root/.hermes/config.yaml",
    "echo x >> ~/.hermes/config.yaml",
    "cp /tmp/c.yaml /root/.hermes/config.yaml",
    "grep -n cdp_url /root/.hermes/config.yaml 2>/dev/null",
    "cat /root/.hermes/config.yaml | head",
    "hermes config show",
    "cat /etc/joshu/instance.env",
]
print(json.dumps({c: json.loads(tt.terminal_tool(c)).get("status") == "blocked" for c in cases}))
`).trim(),
);
assert.deepEqual(Object.values(verdicts), [true, true, true, true, true, false, false, false, true]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-hermes-tool-patches — all passed");
