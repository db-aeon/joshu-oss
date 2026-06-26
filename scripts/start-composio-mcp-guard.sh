#!/usr/bin/env bash
# Start Composio MCP guard proxy (Hermes → local :8796 → Composio cloud with write gate).
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export JOSHU_COMPOSIO_MCP_GUARD_PORT="${JOSHU_COMPOSIO_MCP_GUARD_PORT:-8796}"
export JOSHU_COMPOSIO_MCP_GUARD_HOST="${JOSHU_COMPOSIO_MCP_GUARD_HOST:-127.0.0.1}"
_joshu_port="${JOSHU_PORT:-8788}"
_default_api_base="http://127.0.0.1:${_joshu_port}${PUBLIC_BASE_PATH:-/joshu}"
export JOSHU_CONNECTORS_API_BASE="${JOSHU_CONNECTORS_API_BASE:-${_default_api_base}}"
if [[ "${JOSHU_CONNECTORS_API_BASE}" == *":8787"* ]]; then
  echo "[composio-mcp-guard] WARN: JOSHU_CONNECTORS_API_BASE=${JOSHU_CONNECTORS_API_BASE} looks like ArozOS :8787; using ${_default_api_base}" >&2
  export JOSHU_CONNECTORS_API_BASE="${_default_api_base}"
fi

PID_FILE="${JOSHU_COMPOSIO_MCP_GUARD_PID_FILE:-${HOME}/.joshu/composio-mcp-guard.pid}"
LOG_FILE="${JOSHU_COMPOSIO_MCP_GUARD_LOG_FILE:-${HOME}/.joshu/composio-mcp-guard.log}"
HEALTH_URL="http://${JOSHU_COMPOSIO_MCP_GUARD_HOST}:${JOSHU_COMPOSIO_MCP_GUARD_PORT}/health"

mkdir -p "$(dirname "${PID_FILE}")" "$(dirname "${LOG_FILE}")"

guard_health_ok() {
  curl -fsS "${HEALTH_URL}" >/dev/null 2>&1
}

stop_stale_guard() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 0
  fi
  local old_pid
  old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    kill "${old_pid}" 2>/dev/null || true
    sleep 1
    kill -9 "${old_pid}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
}

if [[ -f "${PID_FILE}" ]]; then
  old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null && guard_health_ok; then
    echo "[composio-mcp-guard] already running pid=${old_pid}"
    exit 0
  fi
  echo "[composio-mcp-guard] stale or unhealthy pid=${old_pid:-none}; restarting" >&2
  stop_stale_guard
fi

nohup node "${APP_DIR}/scripts/composio-mcp-guard-proxy.mjs" >>"${LOG_FILE}" 2>&1 &
echo $! >"${PID_FILE}"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if guard_health_ok; then
    echo "[composio-mcp-guard] started pid=$(cat "${PID_FILE}") port=${JOSHU_COMPOSIO_MCP_GUARD_PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "[composio-mcp-guard] ERROR: process started but health check failed (${HEALTH_URL})" >&2
tail -20 "${LOG_FILE}" 2>/dev/null >&2 || true
exit 1
