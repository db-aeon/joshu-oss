#!/usr/bin/env bash
# Kanban dashboard WebSocket must honour __HERMES_BASE_PATH__ when Joshu (or any
# reverse proxy) serves Hermes admin under a path prefix, e.g. /joshu/hermes-admin.
# REST calls already use SDK.fetchJSON (BASE + path); the bundled kanban index.js
# built the WS URL as /api/plugins/kanban/events at the site root → Caddy sends
# that to ArozOS :8787, not Hermes :9119 via the Joshu proxy.
#
# Also deploy/deploy/Caddyfile rewrites /api/plugins/kanban/* → /joshu/hermes-admin/api/...
# so the board works even when this patch cannot be applied (Hermes pin drift).
set -euo pipefail

HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
KANBAN_JS="${HERMES_DIR}/plugins/kanban/dashboard/dist/index.js"

if [[ ! -f "${KANBAN_JS}" ]]; then
  echo "[hermes-kanban-ws-patch] skip: ${KANBAN_JS} not found"
  exit 0
fi

if rg -q 'function kanbanDashboardBasePath' "${KANBAN_JS}" 2>/dev/null; then
  echo "[hermes-kanban-ws-patch] already applied"
  exit 0
fi

python3 - <<'PY' "${KANBAN_JS}"
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

helper = """
  function kanbanDashboardBasePath() {
    const injected = (window.__HERMES_BASE_PATH__ || "").replace(/\\/+$/, "");
    if (injected) return injected;
    const m = window.location.pathname.match(/^(\\/.+?\\/hermes-admin)(?:\\/|$)/);
    return m ? m[1] : "";
  }
"""

# Insert helper once, near other top-level helpers (after MIME_TASK).
anchor = '  const MIME_TASK = "text/x-hermes-task";'
if anchor not in text:
    raise SystemExit("anchor not found — upstream kanban bundle changed")
if "function kanbanDashboardBasePath" not in text:
    text = text.replace(anchor, anchor + helper, 1)

# Replace any legacy one-liner WS URL (patched or stock).
patterns = [
    r'const url = `\$\{proto\}//\$\{window\.location\.host\}\$\{basePath\}\$\{API\}/events\?\$\{qs\}`;',
    r'const url = `\$\{proto\}//\$\{window\.location\.host\}\$\{API\}/events\?\$\{qs\}`;',
]
replacement = (
    'const basePath = kanbanDashboardBasePath();\n'
    '        const url = `${proto}//${window.location.host}${basePath}${API}/events?${qs}`;'
)
for pat in patterns:
    new_text, n = re.subn(pat, replacement, text, count=1)
    if n:
        path.write_text(new_text, encoding="utf-8")
        print("[hermes-kanban-ws-patch] applied")
        raise SystemExit(0)

raise SystemExit("WebSocket url line not found — upstream kanban bundle changed")
PY

echo "[hermes-kanban-ws-patch] done — hard-refresh Hermes Admin (Kanban tab) in the browser"
