#!/usr/bin/env bash
# Start the metered MCP relay of one metered provider (Hermes → local port → control plane → provider).
#   start-metered-mcp-relay.sh <provider id> <port>
# The relay URL comes from JOSHU_<PROVIDER ID>_RELAY_URL, for example JOSHU_ROUTER_RELAY_URL. When it
# is not set, a fleet box (CONTROL_PLANE_URL and INSTANCE_AGENT_TOKEN set) uses
# <CONTROL_PLANE_URL>/api/instances/providers/<provider id>/mcp, unless JOSHU_<PROVIDER ID>_MODE is
# off or direct.
# src/mcpSupervisor.ts passes the id and the port of each definition in src/meteredProviders/config.ts.
set -euo pipefail

PROVIDER_ID="${1:?usage: start-metered-mcp-relay.sh <provider id> <port>}"
PORT="${2:?usage: start-metered-mcp-relay.sh <provider id> <port>}"
UPPER_ID="$(printf '%s' "${PROVIDER_ID}" | tr '[:lower:]' '[:upper:]')"
RELAY_URL_VAR="JOSHU_${UPPER_ID}_RELAY_URL"
TAG="[${PROVIDER_ID}-mcp-relay]"

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export JOSHU_METERED_MCP_PROVIDER_ID="${PROVIDER_ID}"
export JOSHU_METERED_MCP_PORT="${PORT}"
export JOSHU_METERED_MCP_HOST="${JOSHU_METERED_MCP_HOST:-127.0.0.1}"
export JOSHU_METERED_MCP_RELAY_URL="${!RELAY_URL_VAR:-}"
MODE_VAR="JOSHU_${UPPER_ID}_MODE"
MODE="$(printf '%s' "${!MODE_VAR:-}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "${JOSHU_METERED_MCP_RELAY_URL}" && "${MODE}" != "off" && "${MODE}" != "direct" \
  && -n "${CONTROL_PLANE_URL:-}" && -n "${INSTANCE_AGENT_TOKEN:-}" ]]; then
  export JOSHU_METERED_MCP_RELAY_URL="${CONTROL_PLANE_URL%/}/api/instances/providers/${PROVIDER_ID}/mcp"
fi

PID_FILE="${HOME}/.joshu/${PROVIDER_ID}-mcp-relay.pid"
LOG_FILE="${HOME}/.joshu/${PROVIDER_ID}-mcp-relay.log"
HEALTH_URL="http://${JOSHU_METERED_MCP_HOST}:${JOSHU_METERED_MCP_PORT}/health"

mkdir -p "$(dirname "${PID_FILE}")" "$(dirname "${LOG_FILE}")"
# shellcheck source=lib/pid-file.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pid-file.sh"

health_ok() {
  curl -fsS "${HEALTH_URL}" >/dev/null 2>&1
}

stop_stale() {
  stop_pid_file_process "${PID_FILE}" "metered-mcp-relay.mjs" "${TAG}" 1
}

if [[ -z "${JOSHU_METERED_MCP_RELAY_URL}" ]]; then
  echo "${TAG} no relay URL (${RELAY_URL_VAR} or CONTROL_PLANE_URL) — skipping start" >&2
  exit 0
fi

if [[ -f "${PID_FILE}" ]]; then
  old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if pid_runs_command "${old_pid}" "metered-mcp-relay.mjs" && health_ok; then
    echo "${TAG} already running pid=${old_pid}"
    exit 0
  fi
  echo "${TAG} stale or unhealthy pid=${old_pid:-none}; restarting" >&2
  stop_stale
fi

nohup node "${APP_DIR}/scripts/lib/metered-mcp-relay.mjs" >>"${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
sleep 1
if health_ok; then
  echo "${TAG} started pid=$(cat "${PID_FILE}")"
else
  echo "${TAG} started but health check failed — see ${LOG_FILE}" >&2
fi
