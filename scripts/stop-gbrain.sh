#!/usr/bin/env bash
# Stop gbrain background workers and release stale PGLite locks for this GBRAIN_HOME.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=lib/gbrain-env.sh
source "${APP_DIR}/scripts/lib/gbrain-env.sh"
gbrain_env_init "${BASH_SOURCE[0]}"
GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
GBRAIN_PID_FILE="${GBRAIN_PID_FILE:-${GBRAIN_HOME}/gbrain-sync.pid}"
GBRAIN_EMBED_PID_FILE="${GBRAIN_EMBED_PID_FILE:-${GBRAIN_HOME}/gbrain-embed.pid}"
GBRAIN_DB="${GBRAIN_HOME}/.gbrain/brain.pglite"
GBRAIN_LOCK_DIR="${GBRAIN_DB}/.gbrain-lock"

stop_sync_watch_pidfile() {
  if [[ ! -f "${GBRAIN_PID_FILE}" ]]; then
    return 0
  fi
  local old_pid
  old_pid="$(cat "${GBRAIN_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "[gbrain] stopping sync --watch (pid ${old_pid})"
    kill "${old_pid}" 2>/dev/null || true
    sleep 0.5
    kill -9 "${old_pid}" 2>/dev/null || true
  fi
  rm -f "${GBRAIN_PID_FILE}"
}

stop_embed_loop_pidfile() {
  if [[ ! -f "${GBRAIN_EMBED_PID_FILE}" ]]; then
    return 0
  fi
  local old_pid
  old_pid="$(cat "${GBRAIN_EMBED_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "[gbrain] stopping embed loop (pid ${old_pid})"
    kill "${old_pid}" 2>/dev/null || true
    sleep 0.5
    kill -9 "${old_pid}" 2>/dev/null || true
  fi
  rm -f "${GBRAIN_EMBED_PID_FILE}"
}

stop_gbrain_mcp_proxies() {
  local pid
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    echo "[gbrain] stopping gbrain MCP proxy (pid ${pid})"
    kill "${pid}" 2>/dev/null || true
  done < <(pgrep -f "gbrain-mcp-readonly-proxy" 2>/dev/null || true)
  sleep 0.5
}

stop_gbrain_mcp_http() {
  local pid_file="${GBRAIN_MCP_HTTP_PID_FILE:-${GBRAIN_HOME}/gbrain-mcp-http.pid}"
  if [[ -f "${pid_file}" ]]; then
    local old_pid
    old_pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      echo "[gbrain] stopping gbrain MCP HTTP server (pid ${old_pid})"
      kill "${old_pid}" 2>/dev/null || true
      sleep 0.5
      kill -9 "${old_pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
  fi
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    echo "[gbrain] stopping gbrain MCP HTTP server (pid ${pid})"
    kill "${pid}" 2>/dev/null || true
  done < <(pgrep -f "gbrain-mcp-http-server" 2>/dev/null || true)
  sleep 0.5
}

stop_gbrain_serve_for_home() {
  local pid cmdline
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    cmdline="$(ps -ww -p "${pid}" -o command= 2>/dev/null || true)"
    [[ "${cmdline}" == *"gbrain"*serve* ]] || continue
  # Prior dev sessions often leave Hermes MCP `gbrain serve` running after Ctrl+C.
    echo "[gbrain] stopping stale gbrain serve (pid ${pid})"
    kill "${pid}" 2>/dev/null || true
    sleep 0.5
    kill -9 "${pid}" 2>/dev/null || true
  done < <(pgrep -f "${GBRAIN_BIN} serve" 2>/dev/null || true)
  sleep 0.5
}

remove_stale_pglite_lock() {
  [[ -d "${GBRAIN_LOCK_DIR}" ]] || return 0
  local lock_file="${GBRAIN_LOCK_DIR}/lock"
  [[ -f "${lock_file}" ]] || return 0

  local lock_pid=""
  lock_pid="$(node - "${lock_file}" <<'NODE' 2>/dev/null || true
const fs = require('fs');
try {
  const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (data && data.pid) process.stdout.write(String(data.pid));
} catch {}
NODE
)"

  if [[ -n "${lock_pid}" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
    return 0
  fi

  echo "[gbrain] removing stale PGLite lock at ${GBRAIN_LOCK_DIR}"
  rm -rf "${GBRAIN_LOCK_DIR}"
}

echo "[gbrain] releasing prior gbrain processes for ${GBRAIN_HOME}"
stop_sync_watch_pidfile
stop_embed_loop_pidfile
stop_gbrain_mcp_proxies
stop_gbrain_mcp_http
stop_gbrain_serve_for_home
remove_stale_pglite_lock
