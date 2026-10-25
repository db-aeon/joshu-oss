#!/usr/bin/env bash
# Start dev:arozos detached from the launching shell (survives Cursor agent session end).
#
# Usage:
#   npm run dev:arozos:daemon
#   npm run dev:arozos:stop
#
# Logs: .local/dev-arozos.log
# PID:  .local/dev-arozos.pid
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${ROOT_DIR}/.local"
PID_FILE="${LOCAL_DIR}/dev-arozos.pid"
# shellcheck source=lib/pid-file.sh
source "${ROOT_DIR}/scripts/lib/pid-file.sh"
LOG_FILE="${LOCAL_DIR}/dev-arozos.log"

mkdir -p "${LOCAL_DIR}"

if [[ -f "${PID_FILE}" ]]; then
  read -r existing_pid < "${PID_FILE}" || true
  if pid_runs_command "${existing_pid:-}" "dev-arozos.sh"; then
    echo "[dev-arozos-daemon] already running (pid ${existing_pid})"
    echo "[dev-arozos-daemon] log: ${LOG_FILE}"
    echo "[dev-arozos-daemon] open http://127.0.0.1:8787"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

# Stale jTerm from prior runs blocks subservice bind on :12820.
jterm_pids="$(lsof -tiTCP:12820 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${jterm_pids}" ]]; then
  echo "[dev-arozos-daemon] freeing stale jTerm on :12820 (pids: ${jterm_pids})"
  # shellcheck disable=SC2086
  kill ${jterm_pids} 2>/dev/null || true
fi

echo "[dev-arozos-daemon] starting detached stack (log: ${LOG_FILE})"
# nohup + disown: survive parent shell exit (Cursor agent sessions, closed terminals).
nohup bash "${ROOT_DIR}/scripts/dev-arozos.sh" >>"${LOG_FILE}" 2>&1 </dev/null &
daemon_pid=$!
disown -h "${daemon_pid}" 2>/dev/null || disown "${daemon_pid}" 2>/dev/null || true
echo "${daemon_pid}" >"${PID_FILE}"

# Wait for Joshu health (build can take a few minutes on cold start).
health_url="http://127.0.0.1:${JOSHU_PORT:-8788}${PUBLIC_BASE_PATH:-/joshu}/api/status"
for _ in $(seq 1 180); do
  if ! kill -0 "${daemon_pid}" >/dev/null 2>&1; then
    echo "[dev-arozos-daemon] failed to start — tail ${LOG_FILE}" >&2
    rm -f "${PID_FILE}"
    exit 1
  fi
  if curl -fsS "${health_url}" >/dev/null 2>&1; then
    echo "[dev-arozos-daemon] pid ${daemon_pid}"
    echo "[dev-arozos-daemon] open http://127.0.0.1:${PUBLIC_AROZ_PORT:-8787}"
    echo "[dev-arozos-daemon] log: ${LOG_FILE}"
    exit 0
  fi
  sleep 2
done

echo "[dev-arozos-daemon] timed out waiting for ${health_url} — still starting; tail ${LOG_FILE}" >&2
echo "[dev-arozos-daemon] pid ${daemon_pid}"
