#!/usr/bin/env bash
# Start Joshu-supervised gbrain MCP HTTP server (one gbrain serve + :8794).
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=lib/gbrain-env.sh
source "${APP_DIR}/scripts/lib/gbrain-env.sh"
gbrain_env_init "${BASH_SOURCE[0]}"

AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
joshu_files_resolve_paths "${APP_DIR}" 2>/dev/null || true
export JOSHU_FILES_ROOT JOSHU_DESKTOP_ROOT JOSHU_AROZ_USER GBRAIN_SOURCE AROZ_DATA

export GOOGLE_API_KEY="${GOOGLE_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-}}"
export GOOGLE_GENERATIVE_AI_API_KEY="${GOOGLE_GENERATIVE_AI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}}"

gbrain_require_pglite_brain
GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"

# One PGLite holder: stop stale serve/sync before MCP HTTP spawns gbrain serve.
bash "${APP_DIR}/scripts/stop-gbrain.sh"
gbrain_repair_pglite_config_if_needed

if ! gbrain_run sync --dry-run >/dev/null 2>&1; then
  echo "[gbrain-mcp-http] WARN: PGLite open failed; attempting repair (GBRAIN_REPAIR_PGLITE=1)" >&2
  GBRAIN_REPAIR_PGLITE=1 bash "${APP_DIR}/scripts/repair-gbrain-pglite.sh" || true
fi

# Ensure Desktop git repo before MCP server starts (sync_brain needs it).
# shellcheck source=lib/ensure-gbrain-git.sh
source "${APP_DIR}/scripts/lib/ensure-gbrain-git.sh"
if [[ -n "${JOSHU_DESKTOP_ROOT:-}" ]]; then
  ensure_gbrain_git_repo "${JOSHU_DESKTOP_ROOT}"
fi

GBRAIN_MCP_HTTP_PORT="${GBRAIN_MCP_HTTP_PORT:-8794}"
GBRAIN_MCP_HTTP_HOST="${GBRAIN_MCP_HTTP_HOST:-127.0.0.1}"
GBRAIN_MCP_HTTP_URL="${GBRAIN_MCP_HTTP_URL:-http://${GBRAIN_MCP_HTTP_HOST}:${GBRAIN_MCP_HTTP_PORT}}"
GBRAIN_MCP_HTTP_PID_FILE="${GBRAIN_MCP_HTTP_PID_FILE:-${GBRAIN_HOME}/gbrain-mcp-http.pid}"
GBRAIN_LOG_FILE="${GBRAIN_LOG_FILE:-${GBRAIN_HOME}/gbrain-mcp-http.log}"

health_url="${GBRAIN_MCP_HTTP_URL%/}/health"

gbrain_mcp_session_ready() {
  curl -fsS "${health_url}" 2>/dev/null | grep -q '"session_ready":true'
}

gbrain_mcp_process_up() {
  curl -fsS "${health_url}" 2>/dev/null | grep -q '"ok":true'
}

if gbrain_mcp_session_ready; then
  echo "[gbrain-mcp-http] already healthy at ${health_url}"
  exit 0
fi

mkdir -p "$(dirname "${GBRAIN_LOG_FILE}")" "${GBRAIN_HOME}"

export GBRAIN_HOME
export GBRAIN_MCP_HTTP_PORT
export GBRAIN_MCP_HTTP_HOST
export GBRAIN_MCP_HTTP_URL
export GBRAIN_LOG_FILE
export PATH="${HOME}/.bun/bin:/usr/local/bin:${PATH}"

echo "[gbrain-mcp-http] starting on ${GBRAIN_MCP_HTTP_URL} (GBRAIN_HOME=${GBRAIN_HOME}, log: ${GBRAIN_LOG_FILE})"

start_server_once() {
  if [[ -f "${GBRAIN_MCP_HTTP_PID_FILE}" ]]; then
    local old_pid
    old_pid="$(cat "${GBRAIN_MCP_HTTP_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      echo "[gbrain-mcp-http] stopping stale server (pid ${old_pid})"
      kill "${old_pid}" 2>/dev/null || true
      sleep 0.5
      kill -9 "${old_pid}" 2>/dev/null || true
    fi
    rm -f "${GBRAIN_MCP_HTTP_PID_FILE}"
  fi

  nohup node "${APP_DIR}/scripts/gbrain-mcp-http-server.mjs" >>"${GBRAIN_LOG_FILE}" 2>&1 &
  server_pid=$!
  printf '%s\n' "${server_pid}" > "${GBRAIN_MCP_HTTP_PID_FILE}"

  for _ in $(seq 1 "${GBRAIN_MCP_HTTP_STARTUP_ATTEMPTS:-180}"); do
    if gbrain_mcp_session_ready; then
      echo "[gbrain-mcp-http] healthy at ${health_url}"
      return 0
    fi
    if gbrain_mcp_process_up; then
      :
    elif ! kill -0 "${server_pid}" >/dev/null 2>&1; then
      echo "[gbrain-mcp-http] exited before becoming healthy; recent log follows" >&2
      tail -n 80 "${GBRAIN_LOG_FILE}" >&2 || true
      wait "${server_pid}" || true
      return 1
    fi
    sleep 1
  done

  echo "[gbrain-mcp-http] timed out waiting for ${health_url}; recent log follows" >&2
  tail -n 80 "${GBRAIN_LOG_FILE}" >&2 || true
  return 1
}

if start_server_once; then
  exit 0
fi

if [[ "${GBRAIN_MCP_AUTO_REPAIR:-true}" =~ ^(1|true|yes)$ ]]; then
  echo "[gbrain-mcp-http] attempting PGLite repair before retry" >&2
  GBRAIN_REPAIR_PGLITE=1 bash "${APP_DIR}/scripts/repair-gbrain-pglite.sh" || true
  bash "${APP_DIR}/scripts/stop-gbrain.sh" || true
  if start_server_once; then
    exit 0
  fi
fi

exit 1
