#!/usr/bin/env node
/**
 * Self-contained tests for the Hermes tool patches (no hermes-agent checkout):
 *
 * - patch-hermes-browser-cdp-guards.mjs on a synthetic browser_tool.py:
 *   fresh apply, idempotency, upgrade from the old touch patch (which inserted
 *   calls inside multi-line signatures), and runtime cloud-ensure behavior with
 *   a stubbed `requests` (URL adoption, stale session drop, browser_unavailable).
 * - patch-hermes-terminal-secrets-guard.mjs: Hermes config and runtime file
 *   writes blocked, reads allowed, upgrade from the earlier helper, and the same
 *   check on execute_code scripts.
 * - patch-hermes-approval-no-permanent.py: no Always choice, "always" lasts
 *   for the session, old command_allowlist entries ignored, nothing saved.
 * - patch-hermes-factory-skill-background-writes.mjs: background review may
 *   patch skills under $HERMES_HOME/skills/joshu/; delete stays refused.
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
assert.ok(upgraded.includes("joshu_cloud_browser_ensure_v3"));
assert.ok(upgraded.includes("LEGACY_SENTINEL = 1"), "module code after the old helper survives");
assert.match(runPatch(browserPatch, legacy), /already applied/);

// --- Upgrade from v2 ensure (no browser_restarted branch) ---
const v2Path = path.join(tmp, "v2_browser_tool.py");
const restartedBranch = /\n    restarted = payload\.get\("restarted"\)\n[\s\S]*?\n        \)\n/;
assert.match(once, restartedBranch, "v3 helper has the browser_restarted branch");
fs.writeFileSync(
  v2Path,
  once.replaceAll("joshu_cloud_browser_ensure_v3", "joshu_cloud_browser_ensure_v2").replace(restartedBranch, "\n"),
);
assert.ok(pyCompiles(v2Path), "v2 fixture compiles");
runPatch(browserPatch, v2Path);
const v3 = fs.readFileSync(v2Path, "utf8");
assert.ok(pyCompiles(v2Path), "v2 → v3 upgrade compiles");
assert.ok(v3.includes("joshu_cloud_browser_ensure_v3"));
assert.equal((v3.match(/"browser_restarted"/g) || []).length, 1);
assert.equal((v3.match(/^def _joshu_cloud_browser_touch/gm) || []).length, 1);
assert.equal((v3.match(/_joshu_ensure_err = _joshu_cloud_browser_touch\(\)/g) || []).length, 10);
assert.match(runPatch(browserPatch, v2Path), /already applied/);

// --- Upgrade from v1 ensure (host-based drop, no relay generation) ---
const v1 = path.join(tmp, "v1_browser_tool.py");
fs.writeFileSync(
  v1,
  once
    .replaceAll("joshu_cloud_browser_ensure_v3", "joshu_cloud_browser_ensure")
    .replaceAll("_joshu_drop_cdp_sessions", "_joshu_drop_stale_cdp_sessions"),
);
assert.ok(pyCompiles(v1), "v1 fixture compiles");
runPatch(browserPatch, v1);
const v2 = fs.readFileSync(v1, "utf8");
assert.ok(pyCompiles(v1), "v1 → v2 upgrade compiles");
assert.ok(v2.includes("joshu_cloud_browser_ensure_v3"));
assert.equal((v2.match(/^def _joshu_cloud_browser_touch/gm) || []).length, 1);
assert.equal((v2.match(/^def _joshu_drop_cdp_sessions/gm) || []).length, 1);
assert.equal((v2.match(/^def _joshu_drop_stale_cdp_sessions/gm) || []).length, 0, "v1 drop helper removed");
assert.equal((v2.match(/^_JOSHU_BROWSER_UNAVAILABLE = \{/gm) || []).length, 1, "prelude not duplicated");
assert.equal((v2.match(/_joshu_ensure_err = _joshu_cloud_browser_touch\(\)/g) || []).length, 10);
assert.match(runPatch(browserPatch, v1), /already applied/);

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
out = {"nav": nav, "env": os.environ["BROWSER_CDP_URL"], "cleaned": list(bt.CLEANED), "left": sorted(bt._active_sessions)}

state["ensure"] = (502, {"ok": False, "backend": "cloud", "error": "browser_unavailable"})
out["down"] = json.loads(bt.browser_console())

state["ensure"] = (404, None)
out["old_stack"] = json.loads(bt.browser_snapshot())
out["touch"] = state["touch"]

state["ensure"] = (200, {"ok": True, "backend": "local", "cdpUrl": ""})
out["local_env"] = json.loads(bt.browser_scroll("down")) and os.environ["BROWSER_CDP_URL"]

# Relay: the endpoint stays put; a new generation means the browser behind it changed.
bt.CLEANED.clear()
relay = "http://127.0.0.1:9333"
state["ensure"] = (200, {"ok": True, "backend": "cloud", "cdpUrl": relay, "generation": 1})
bt.browser_snapshot()
bt._active_sessions["t2"] = {"cdp_url": "ws://127.0.0.1:9333/devtools/browser/a", "features": {"cdp_override": True}}
bt.browser_snapshot()
out["same_generation_kept"] = sorted(bt._active_sessions)
state["ensure"] = (200, {"ok": True, "backend": "cloud", "cdpUrl": relay, "generation": 2})
bt.browser_snapshot()
out["relay_env"] = os.environ["BROWSER_CDP_URL"]
out["relay_generation"] = os.environ["JOSHU_CDP_GENERATION"]
out["relay_cleaned"] = [key for key, _ in bt.CLEANED]
out["relay_left"] = sorted(bt._active_sessions)

# After an idle stop: one browser_restarted error, then the call works.
notice = {"stoppedAt": "2026-10-16T00:06:19.000Z", "idleMinutes": 5, "message": "Joshu stopped the shared browser."}
state["ensure"] = (200, {"ok": True, "backend": "cloud", "cdpUrl": relay, "generation": 3, "restarted": notice})
out["restarted"] = json.loads(bt.browser_navigate("https://example.com", task_id="t3"))
out["restarted_generation"] = os.environ["JOSHU_CDP_GENERATION"]
state["ensure"] = (200, {"ok": True, "backend": "cloud", "cdpUrl": relay, "generation": 3})
out["after_restart"] = json.loads(bt.browser_navigate("https://example.com", task_id="t3"))
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
assert.deepEqual(r.same_generation_kept, ["local", "t2"], "same relay generation keeps sessions");
assert.equal(r.relay_env, "http://127.0.0.1:9333");
assert.equal(r.relay_generation, "2");
assert.deepEqual(r.relay_cleaned, ["t2"], "a new generation drops sessions bound to the old browser");
assert.deepEqual(r.relay_left, ["local"]);
assert.equal(r.restarted.error, "browser_restarted");
assert.equal(r.restarted.message, "Joshu stopped the shared browser.");
assert.equal(r.restarted.stoppedAt, "2026-10-16T00:06:19.000Z");
assert.equal(r.restarted_generation, "3", "the new browser is adopted before the notice returns");
assert.equal(r.after_restart.success, true, "the next call runs on the new browser");

// --- Terminal guard: Hermes config and runtime file writes blocked, reads allowed ---
// The fixture is a tools/ package, so the execute_code patch can import tools.terminal_tool.
const hermesTools = path.join(tmp, "hermes/tools");
fs.mkdirSync(hermesTools, { recursive: true });
fs.writeFileSync(path.join(hermesTools, "__init__.py"), "");
const terminal = path.join(hermesTools, "terminal_tool.py");
const terminalFixture = `import json
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
`;
const codeExec = path.join(hermesTools, "code_execution_tool.py");
const codeExecFixture = `import json
import logging

logger = logging.getLogger(__name__)


def execute_code(code: str) -> str:
    if not code:
        return json.dumps({"status": "error"})

    # Dispatch: remote backends use file-based RPC, local uses UDS
    return json.dumps({"status": "success", "output": "ran"})
`;
fs.writeFileSync(terminal, terminalFixture);
fs.writeFileSync(codeExec, codeExecFixture);
assert.match(runPatch(terminalPatch, terminal), /applied execute_code secrets-guard patch/);
const terminalOnce = fs.readFileSync(terminal, "utf8");
const codeExecOnce = fs.readFileSync(codeExec, "utf8");
assert.match(runPatch(terminalPatch, terminal), /execute_code secrets-guard patch already applied/);
assert.equal(fs.readFileSync(terminal, "utf8"), terminalOnce, "terminal guard is idempotent");
assert.equal(fs.readFileSync(codeExec, "utf8"), codeExecOnce, "execute_code guard is idempotent");
assert.ok(pyCompiles(codeExec), "patched code_execution_tool.py compiles");

const hermesRoot = path.join(tmp, "hermes");
const terminalCases = [
  ['/opt/hermes-agent/venv/bin/hermes config set browser.cdp_url "https://x"', true],
  ["hermes config edit", true],
  ["sed -i 's/a/b/' /root/.hermes/config.yaml", true],
  ["echo x >> ~/.hermes/config.yaml", true],
  ["cp /tmp/c.yaml /root/.hermes/config.yaml", true],
  ["grep -n cdp_url /root/.hermes/config.yaml 2>/dev/null", false],
  ["cat /root/.hermes/config.yaml | head", false],
  ["hermes config show", false],
  ["cat /etc/joshu/instance.env", true],
  // Runtime files (change companion-runtime-guard).
  ["/opt/hermes-agent/venv/bin/pip install 'av<13'", true],
  ["source /opt/hermes-agent/venv/bin/activate && pip install av==12.3.0", true],
  ["uv pip install --python /opt/hermes-agent/venv/bin/python av", true],
  ["sed -i 's/provider: .*/provider: local/' /root/.hermes/config.user.yaml", true],
  ["cp /tmp/x.py /opt/hermes-agent/tools/transcription_tools.py", true],
  ["rm -rf /opt/hermes-agent/venv/lib/python3.11/site-packages/av", true],
  ["cat new.js | tee /opt/joshu/dist/server.js", true],
  ["echo '{}' > /var/lib/arozos/joshu-state/telephone/settings.json", true],
  ["cat /var/lib/arozos/joshu-state/telephone/settings.json", true],
  ["python3 - <<'PY'\nprint(open('/var/lib/arozos/joshu-state/telephone/settings.json').read())\nPY", true],
  [`curl -X PUT http://127.0.0.1:8788/joshu/api/telephone -d '{"trustVerifiedCallerId":true}'`, true],
  ["curl -s -X POST http://127.0.0.1:8788/joshu/api/telephone/passphrase", true],
  ["python3 - <<'PY'\np='/root/.hermes/config.yaml'\ns=open(p).read().replace('a','b')\nopen(p,'w').write(s)\nPY", true],
  ["grep -n stt /root/.hermes/config.user.yaml", false],
  ["/opt/hermes-agent/venv/bin/pip show av", false],
  ["/opt/hermes-agent/venv/bin/hermes kanban list | tee /tmp/joshu-scratch/k.txt", false],
  ["/opt/hermes-agent/venv/bin/hermes kanban show t_1 > /tmp/joshu-scratch/t.json 2>/dev/null", false],
  ["node /opt/joshu/scripts/box-check.mjs 2>&1 | head", false],
  ["curl -s http://127.0.0.1:8788/joshu/api/telephone", false],
  ["pip install pandas", false],
];
const terminalBlocked = JSON.parse(
  python(
    `
import json, sys
sys.path.insert(0, ".")
import tools.terminal_tool as tt
cases = ${JSON.stringify(terminalCases.map(([c]) => c))}
print(json.dumps([json.loads(tt.terminal_tool(c)).get("status") == "blocked" for c in cases]))
`,
    hermesRoot,
  ).trim(),
);
assert.deepEqual(
  terminalCases.map(([c], i) => [c, terminalBlocked[i]]),
  terminalCases,
  "terminal guard verdicts",
);

// execute_code: a script that writes the Hermes config never runs; a read-only script runs.
const codeVerdicts = JSON.parse(
  python(
    `
import json, sys
sys.path.insert(0, ".")
from tools.code_execution_tool import execute_code
write = "p = '/root/.hermes/config.yaml'\\ns = open(p).read().replace('a', 'b')\\nopen(p, 'w').write(s)\\n"
read = "import yaml\\nprint(yaml.safe_load(open('/root/.hermes/config.yaml'))['model'])\\n"
print(json.dumps([json.loads(execute_code(write)), json.loads(execute_code(read))]))
`,
    hermesRoot,
  ).trim(),
);
assert.equal(codeVerdicts[0].status, "error");
assert.match(codeVerdicts[0].error, /runtime file of the box/);
assert.equal(codeVerdicts[1].status, "success");

// Upgrade from the earlier helper block (config.yaml only, before change companion-runtime-guard).
const legacyTerminal = path.join(tmp, "legacy_terminal_tool.py");
fs.writeFileSync(
  legacyTerminal,
  terminalFixture.replace(
    "logger = logging.getLogger(__name__)\n",
    `logger = logging.getLogger(__name__)

def _joshu_terminal_secrets_guard_enabled() -> bool:
    return True


def _joshu_terminal_secrets_blocked(command: str) -> Optional[str]:
    """Old helper (hitl_terminal_secrets_guard)."""
    if "config.yaml" in command and "sed -i" in command:
        return "Blocked: Hermes config is managed by Joshu"
    return None

LEGACY_SENTINEL = 1
`,
  ).replace(
    "        # Pre-exec security checks",
    `        secrets_block = _joshu_terminal_secrets_blocked(command)
        if secrets_block:
            return json.dumps({"output": "", "exit_code": -1, "error": secrets_block, "status": "blocked"})
        # Pre-exec security checks`,
  ),
);
assert.ok(pyCompiles(legacyTerminal), "legacy terminal fixture compiles");
runPatch(terminalPatch, legacyTerminal);
const upgradedTerminal = fs.readFileSync(legacyTerminal, "utf8");
assert.ok(pyCompiles(legacyTerminal), "upgraded terminal guard compiles");
assert.equal((upgradedTerminal.match(/^def _joshu_terminal_secrets_blocked/gm) || []).length, 1);
assert.equal((upgradedTerminal.match(/^def _joshu_runtime_write/gm) || []).length, 1);
assert.equal((upgradedTerminal.match(/_joshu_terminal_secrets_blocked\(command\)/g) || []).length, 1);
assert.ok(upgradedTerminal.includes("LEGACY_SENTINEL = 1"), "module code after the old helper survives");
assert.match(runPatch(terminalPatch, legacyTerminal), /terminal secrets-guard patch already applied/);
assert.equal(fs.readFileSync(legacyTerminal, "utf8"), upgradedTerminal);

// --- Approval patch: no Always choice, no permanent approvals ---
const approvalPatch = path.join(root, "scripts/patch-hermes-approval-no-permanent.py");
const approval = path.join(hermesTools, "approval.py");
// The four places as in tools/approval.py at the Hermes pin, plus a caller of "always".
const approvalFixture = `import logging
import threading

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_session_approved: dict = {}
_permanent_approved: set = set()
SAVED = []


def approve_session(session_key: str, pattern_key: str):
    """Approve a pattern for this session only."""
    with _lock:
        _session_approved.setdefault(session_key, set()).add(pattern_key)


def is_approved(session_key: str, pattern_key: str) -> bool:
    with _lock:
        return pattern_key in _permanent_approved or pattern_key in _session_approved.get(session_key, set())


def approve_permanent(pattern_key: str):
    """Add a pattern to the permanent allowlist."""
    with _lock:
        _permanent_approved.add(pattern_key)


def load_permanent(patterns: set):
    """Bulk-load permanent allowlist entries from config."""
    with _lock:
        _permanent_approved.update(patterns)


def save_permanent_allowlist(patterns: set):
    """Save permanently allowed command patterns to config."""
    SAVED.append(set(patterns))


def _await_gateway_decision(session_key: str, notify_cb, approval_data: dict,
                            *, surface: str = "gateway") -> dict:
    command = approval_data.get("command", "")
    description = approval_data.get("description", "")
    primary_key = approval_data.get("pattern_key", "")
    notify_cb(approval_data)
    return {"resolved": True, "choice": "always"}


def resolve(session_key: str, pattern_key: str, choice: str) -> None:
    if choice == "session":
        approve_session(session_key, pattern_key)
    elif choice == "always":
        approve_session(session_key, pattern_key)
        approve_permanent(pattern_key)
        save_permanent_allowlist(_permanent_approved)
`;
function runApprovalPatch() {
  return spawnSync("python3", [approvalPatch], {
    encoding: "utf8",
    env: { ...process.env, HERMES_DIR: hermesRoot },
  });
}
fs.writeFileSync(approval, approvalFixture.replace("    primary_key = approval_data", "    primary_keys = approval_data"));
const missing = runApprovalPatch();
assert.equal(missing.status, 1, "a missing place fails the patch");
assert.match(missing.stderr, /_await_gateway_decision/);
assert.ok(!fs.readFileSync(approval, "utf8").includes("joshu-approval-no-permanent-v1"), "nothing is written");

fs.writeFileSync(approval, approvalFixture);
assert.match(runApprovalPatch().stdout, /patched/);
const approvalOnce = fs.readFileSync(approval, "utf8");
assert.equal((approvalOnce.match(/joshu-approval-no-permanent-v1/g) || []).length, 4);
assert.match(runApprovalPatch().stdout, /already applied/);
assert.equal(fs.readFileSync(approval, "utf8"), approvalOnce, "approval patch is idempotent");
assert.ok(pyCompiles(approval), "patched approval.py compiles");
const approvalRun = JSON.parse(
  python(
    `
import json, sys
sys.path.insert(0, ".")
from tools import approval as a
a.load_permanent({"execute_code", "script execution via heredoc"})
old_entries = a.is_approved("s1", "execute_code")
seen = []
a._await_gateway_decision("s1", seen.append, {"command": "x", "pattern_key": "execute_code", "allow_permanent": True})
a.resolve("s1", "execute_code", "always")
print(json.dumps({
  "old_entries": old_entries,
  "allow_permanent": seen[0]["allow_permanent"],
  "same_session": a.is_approved("s1", "execute_code"),
  "next_session": a.is_approved("s2", "execute_code"),
  "permanent": sorted(a._permanent_approved),
  "saved": len(a.SAVED),
}))
`,
    hermesRoot,
  ).trim(),
);
assert.deepEqual(approvalRun, {
  old_entries: false,
  allow_permanent: false,
  same_session: true,
  next_session: false,
  permanent: [],
  saved: 0,
});

// Factory-skill background writes: allow patch under skills/joshu/, refuse delete
// and skills outside that tree. Missing needle skips with exit 0.
const factoryPatch = path.join(root, "scripts/patch-hermes-factory-skill-background-writes.mjs");
const skillManager = path.join(tmp, "skill_manager_tool.py");
fs.writeFileSync(
  path.join(tmp, "skill_usage.py"),
  `RECORD = {"created_by": None}

def load_usage():
    return {"skill": RECORD}

def _is_curator_managed_record(record):
    return isinstance(record, dict) and record.get("created_by") == "agent"
`,
);
// Like Hermes tools/skill_manager_tool.py at the pin: no "import os".
const skillManagerSource = `import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def _background_review_write_guard(name, skill_dir, action):
    try:
        import skill_usage
        usage_data = skill_usage.load_usage()
        usage_rec = usage_data.get(name)
        if not skill_usage._is_curator_managed_record(usage_rec):
            return {"success": False, "error": "not curator-managed"}
    except Exception:
        return {"success": False, "error": "ownership unavailable"}
    return None
`;
fs.writeFileSync(skillManager, skillManagerSource);
runPatch(factoryPatch, skillManager);
const factoryOnce = fs.readFileSync(skillManager, "utf8");
assert.match(factoryOnce, /_joshu_factory_skill_background_write/);
runPatch(factoryPatch, skillManager);
assert.equal(fs.readFileSync(skillManager, "utf8"), factoryOnce, "factory write patch is idempotent");
assert.equal(pyCompiles(skillManager), true, "patched skill_manager_tool.py compiles");

const hermesHome = path.join(tmp, "hermes-home");
fs.mkdirSync(path.join(hermesHome, "skills/joshu/proactive/joshu-proactive"), { recursive: true });
fs.mkdirSync(path.join(hermesHome, "skills/hand-written/my-skill"), { recursive: true });
const factoryCases = factoryGuardCases();
function factoryGuardCases() {
  return JSON.parse(
    python(
      `
import json, os, sys
sys.path.insert(0, ".")
os.environ["HERMES_HOME"] = ${JSON.stringify(hermesHome)}
import skill_manager_tool as sm
home = os.environ["HERMES_HOME"]
joshu = home + "/skills/joshu/proactive/joshu-proactive"
other = home + "/skills/hand-written/my-skill"
out = {
  "patch": sm._background_review_write_guard("skill", joshu, "patch"),
  "delete": sm._background_review_write_guard("skill", joshu, "delete"),
  "other": sm._background_review_write_guard("skill", other, "patch"),
}
print(json.dumps(out))
`,
    ).trim(),
  );
}
assert.equal(factoryCases.patch, null, "factory skill patch is allowed");
assert.equal(factoryCases.delete.success, false, "factory skill delete stays refused");
assert.equal(factoryCases.other.success, false, "non-factory skill stays refused");

// A file with the first version of the patch (os.environ without import os) is upgraded.
const firstVersion = factoryOnce
  .replace(
    /                import os as _joshu_os\n                _home = _joshu_os\.environ/,
    "                _home = os.environ",
  )
  .replace("logger.warning(\"joshu factory skill path check failed", "logger.debug(\"joshu factory skill path check failed");
assert.notEqual(firstVersion, factoryOnce, "test builds the first version of the patch");
fs.writeFileSync(skillManager, firstVersion);
assert.equal(factoryGuardCases().patch.success, false, "the first version refuses factory skills (NameError on os)");
assert.match(runPatch(factoryPatch, skillManager), /upgraded \(os import\)/);
assert.equal(fs.readFileSync(skillManager, "utf8"), factoryOnce, "the upgrade gives the current patch");
assert.equal(factoryGuardCases().patch, null, "after the upgrade, factory skill patch is allowed");

const missingNeedle = path.join(tmp, "skill_manager_old.py");
fs.writeFileSync(missingNeedle, "def skill_manage():\n    return None\n");
const skip = runPatch(factoryPatch, missingNeedle);
assert.match(skip, /skip: created_by guard not present/);
assert.equal(fs.readFileSync(missingNeedle, "utf8"), "def skill_manage():\n    return None\n");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-hermes-tool-patches — all passed");
