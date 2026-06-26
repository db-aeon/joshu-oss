#!/usr/bin/env bash
# Start thin Joshu connectors MCP HTTP server (Hermes actions + sync).
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export JOSHU_CONNECTORS_MCP_PORT="${JOSHU_CONNECTORS_MCP_PORT:-8795}"
export JOSHU_CONNECTORS_MCP_HOST="${JOSHU_CONNECTORS_MCP_HOST:-127.0.0.1}"

_joshu_port="${JOSHU_PORT:-8788}"
_default_api_base="http://127.0.0.1:${_joshu_port}${PUBLIC_BASE_PATH:-/joshu}"
export JOSHU_CONNECTORS_API_BASE="${JOSHU_CONNECTORS_API_BASE:-${_default_api_base}}"
# HERMES_HOME/.env often sets PORT=8787 (ArozOS) — never call Joshu REST on the public desktop port.
if [[ "${JOSHU_CONNECTORS_API_BASE}" == *":8787"* ]]; then
  echo "[connectors-mcp] WARN: JOSHU_CONNECTORS_API_BASE=${JOSHU_CONNECTORS_API_BASE} looks like ArozOS :8787; using ${_default_api_base}" >&2
  export JOSHU_CONNECTORS_API_BASE="${_default_api_base}"
fi

PID_FILE="${JOSHU_CONNECTORS_MCP_PID_FILE:-${HOME}/.joshu/connectors-mcp.pid}"
LOG_FILE="${JOSHU_CONNECTORS_MCP_LOG_FILE:-${HOME}/.joshu/connectors-mcp.log}"
HEALTH_URL="http://${JOSHU_CONNECTORS_MCP_HOST}:${JOSHU_CONNECTORS_MCP_PORT}/health"

mkdir -p "$(dirname "${PID_FILE}")" "$(dirname "${LOG_FILE}")"

connectors_mcp_health_ok() {
  # Liveness: process responds (Joshu may still be booting — readiness is HTTP 200 on /health).
  curl -sS "${HEALTH_URL}" 2>/dev/null | grep -q 'joshu-connectors-mcp'
}

stop_stale_connectors_mcp() {
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
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null && connectors_mcp_health_ok; then
    echo "[connectors-mcp] already running pid=${old_pid}"
    exit 0
  fi
  echo "[connectors-mcp] stale or unhealthy pid=${old_pid:-none}; restarting" >&2
  stop_stale_connectors_mcp
fi

nohup node "${APP_DIR}/scripts/joshu-connectors-mcp-http-server.mjs" >>"${LOG_FILE}" 2>&1 &
echo $! >"${PID_FILE}"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if connectors_mcp_health_ok; then
    echo "[connectors-mcp] started pid=$(cat "${PID_FILE}") port=${JOSHU_CONNECTORS_MCP_PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "[connectors-mcp] ERROR: process started but health check failed (${HEALTH_URL})" >&2
tail -20 "${LOG_FILE}" 2>/dev/null >&2 || true
exit 1
