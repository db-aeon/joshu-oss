#!/usr/bin/env bash
# Shared helpers for stopping/restarting the Hermes gateway on VPS boxes.
# gateway.pid is JSON ({"pid": N, ...}) in current Hermes builds — not a bare integer.

read_hermes_gateway_pid() {
  local pid_file="${1:-${HERMES_HOME:-/root/.hermes}/gateway.pid}"
  [[ -f "${pid_file}" ]] || return 0
  python3 - "${pid_file}" <<'PY' 2>/dev/null || true
import json, re, sys
path = sys.argv[1]
raw = open(path, encoding="utf-8").read().strip()
if not raw:
    sys.exit(0)
try:
    data = json.loads(raw)
    pid = data.get("pid")
    if pid:
        print(int(pid))
        sys.exit(0)
except Exception:
    pass
m = re.search(r'"pid"\s*:\s*(\d+)', raw)
if m:
    print(m.group(1))
elif raw.isdigit():
    print(raw)
PY
}

joshu_manages_hermes_gateway() {
  [[ "${HERMES_API_AUTO_START:-true}" =~ ^(1|true|yes)$ ]]
}

joshu_process_running() {
  pgrep -f "node dist/server.js" >/dev/null 2>&1
}

hermes_gateway_health_ok() {
  local base="${HERMES_API_BASE_URL:-http://127.0.0.1:8642}"
  local key="${HERMES_API_KEY:-${API_SERVER_KEY:-}}"
  [[ -n "${key}" ]] || return 1
  curl -fsS --max-time 2 -H "Authorization: Bearer ${key}" "${base%/}/health" >/dev/null 2>&1
}

# Stop a stale gateway process. When Joshu auto-starts the gateway, killing it here
# races with warmGatewayInBackground / ensureApiServer and can leave :8642 down.
restart_hermes_gateway_if_running() {
  if joshu_manages_hermes_gateway && joshu_process_running; then
    return 0
  fi

  local pid=""
  pid="$(read_hermes_gateway_pid)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
    rm -f "${HERMES_HOME:-/root/.hermes}/gateway.pid" "${HERMES_HOME:-/root/.hermes}/gateway.lock" 2>/dev/null || true
    echo "[hermes-gateway] stopped Hermes gateway pid=${pid} so it reloads config/env"
    sleep 2
    return 0
  fi
  # Fallback when pid file is missing/stale but gateway process still owns :8642.
  if pkill -f "/opt/hermes-agent/venv/bin/hermes gateway run" 2>/dev/null; then
    rm -f "${HERMES_HOME:-/root/.hermes}/gateway.pid" "${HERMES_HOME:-/root/.hermes}/gateway.lock" 2>/dev/null || true
    echo "[hermes-gateway] stopped Hermes gateway via process match"
    sleep 2
  fi
}

# After config changes once Joshu is up: let Joshu own gateway lifecycle (ensureJoshuHermesConfig + restart).
nudge_joshu_hermes_gateway() {
  if ! joshu_process_running; then
    restart_hermes_gateway_if_running
    return 0
  fi
  local base="${JOSHU_HEALTH_URL:-http://127.0.0.1:${JOSHU_PORT:-8788}${PUBLIC_BASE_PATH:-/joshu}/api/instance/health}"
  local status_url="${base%/api/instance/health}/api/hermes-chat/status?after_mcp_boot=1"
  local timeout_sec="${JOSHU_HERMES_GATEWAY_NUDGE_TIMEOUT_SEC:-180}"
  local attempt=0
  local max_attempts="${JOSHU_HERMES_GATEWAY_NUDGE_ATTEMPTS:-3}"
  while [[ "${attempt}" -lt "${max_attempts}" ]]; do
    attempt=$((attempt + 1))
    if curl -fsS --max-time "${timeout_sec}" "${status_url}" >/dev/null 2>&1; then
      echo "[hermes-gateway] Joshu confirmed Hermes gateway ready (attempt ${attempt})"
      return 0
    fi
    echo "[hermes-gateway] WARN: after_mcp_boot nudge attempt ${attempt}/${max_attempts} failed; retrying" >&2
    sleep 2
  done
  echo "[hermes-gateway] WARN: Joshu hermes-chat/status nudge timed out after ${max_attempts} attempt(s)" >&2
  return 1
}

reload_hermes_gateway_after_config_change() {
  if joshu_manages_hermes_gateway && joshu_process_running; then
    nudge_joshu_hermes_gateway || true
  else
    restart_hermes_gateway_if_running
  fi
}

wait_for_hermes_gateway() {
  [[ "${HERMES_API_AUTO_START:-true}" =~ ^(1|true|yes)$ ]] || return 0

  local attempts="${JOSHU_HERMES_GATEWAY_BOOT_WAIT_ATTEMPTS:-90}"
  local n=0
  while [[ "${n}" -lt "${attempts}" ]]; do
    if hermes_gateway_health_ok; then
      echo "[hermes-gateway] gateway healthy on ${HERMES_API_BASE_URL:-http://127.0.0.1:8642}"
      return 0
    fi
    if joshu_process_running && (( n % 5 == 0 )); then
      nudge_joshu_hermes_gateway || true
    fi
    sleep 1
    n=$((n + 1))
  done
  echo "[hermes-gateway] WARN: gateway not healthy after ${attempts}s" >&2
  return 1
}

# Product sandboxes disable ~150 bundled Hermes skills via skills.disabled (computed at Joshu gateway sync).
# Empty denylist after image upgrade or factory reset means every bundled skill is enabled — re-nudge Joshu.
verify_hermes_skills_denylist() {
  local config="${HERMES_HOME}/config.yaml"
  [[ -f "${config}" ]] || return 0
  local count
  count="$(python3 - "${config}" <<'PY' 2>/dev/null || echo 0
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    doc = yaml.safe_load(f) or {}
disabled = doc.get("skills", {}).get("disabled") or []
print(len(disabled) if isinstance(disabled, list) else 0)
PY
)"
  if [[ "${count}" -lt 50 ]]; then
    echo "[vps-start] WARN: skills.disabled=${count} (expected ~150+); nudging Joshu Hermes skills policy sync" >&2
    nudge_joshu_hermes_gateway || true
  fi
}
