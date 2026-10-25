#!/usr/bin/env bash
# Stop a detached local dev:arozos stack (see dev-arozos-daemon.sh).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${ROOT_DIR}/.local"
PID_FILE="${LOCAL_DIR}/dev-arozos.pid"
# shellcheck source=lib/pid-file.sh
source "${ROOT_DIR}/scripts/lib/pid-file.sh"

free_port() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "[stop-dev-arozos] freeing stale ${label} listener on :${port} (pids: ${pids})"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.5
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
  fi
}

stop_pid_tree() {
  local pid="$1"
  if ! kill -0 "${pid}" >/dev/null 2>&1; then
    return 1
  fi
  echo "[stop-dev-arozos] stopping dev-arozos (pid ${pid})"
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "[stop-dev-arozos] force-killing pid ${pid}"
  kill -KILL "${pid}" 2>/dev/null || true
}

stopped=0
if [[ -f "${PID_FILE}" ]]; then
  read -r main_pid < "${PID_FILE}" || true
  if pid_runs_command "${main_pid:-}" "dev-arozos.sh" && stop_pid_tree "${main_pid}"; then
    stopped=1
  fi
  rm -f "${PID_FILE}"
fi

# Agent-aborted shells can orphan Joshu/ArozOS without clearing the pid file.
for pid in $(pgrep -f "bash scripts/dev-arozos.sh" 2>/dev/null || true); do
  stop_pid_tree "${pid}" && stopped=1
done

free_port 8788 "Joshu"
free_port 8787 "ArozOS"
free_port 12820 "jTerm"

# Orphaned ArozOS static subservices (survive Ctrl-C of the parent and hold :128xx).
static_pids="$(pgrep -f "scripts/aroz-static-subservice.mjs" 2>/dev/null || true)"
if [[ -n "${static_pids}" ]]; then
  echo "[stop-dev-arozos] killing orphan aroz-static-subservice (pids: ${static_pids})"
  # shellcheck disable=SC2086
  kill ${static_pids} 2>/dev/null || true
  sleep 0.5
  # shellcheck disable=SC2086
  kill -9 ${static_pids} 2>/dev/null || true
  stopped=1
fi
# Free the usual ArozOS subservice port band used in local dev.
for port in $(seq 12810 12840); do
  free_port "${port}" "aroz-static:${port}"
done

export GBRAIN_HOME="${GBRAIN_HOME:-${LOCAL_DIR}/gbrain}"
export GBRAIN_PID_FILE="${GBRAIN_PID_FILE:-${GBRAIN_HOME}/gbrain-sync.pid}"
bash "${ROOT_DIR}/scripts/stop-gbrain.sh" >/dev/null 2>&1 || true

if [[ "${stopped}" -eq 1 ]]; then
  echo "[stop-dev-arozos] done"
else
  echo "[stop-dev-arozos] no running dev-arozos found"
fi
