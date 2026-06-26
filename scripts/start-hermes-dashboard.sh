#!/usr/bin/env bash
# Start Hermes web dashboard (FastAPI on :9119). Joshu reverse-proxies /joshu/hermes-admin.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

load_env_file() {
  local env_file="$1"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

# Local: repo .env has HERMES_BIN. VPS: APP_DIR=/opt/joshu and instance.env are set by vps-start.
load_env_file "${ROOT_DIR}/.env"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
load_env_file "${HERMES_HOME}/.env"

APP_DIR="${APP_DIR:-${ROOT_DIR}}"
HERMES_BIN="${HERMES_BIN:-/opt/hermes-agent/venv/bin/hermes}"
# Local dev sets HERMES_BIN but often not HERMES_DIR — repo root is two levels above venv/bin/hermes.
if [[ -z "${HERMES_DIR:-}" && -x "${HERMES_BIN}" ]]; then
  HERMES_DIR="$(cd "$(dirname "${HERMES_BIN}")/../.." && pwd)"
fi
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
HERMES_DASHBOARD_HOST="${HERMES_DASHBOARD_HOST:-127.0.0.1}"
HERMES_DASHBOARD_PORT="${HERMES_DASHBOARD_PORT:-9119}"
HERMES_DASHBOARD_PID_FILE="${HERMES_DASHBOARD_PID_FILE:-${HERMES_HOME}/hermes-dashboard.pid}"
HERMES_DASHBOARD_LOG_FILE="${HERMES_DASHBOARD_LOG_FILE:-${HERMES_HOME}/hermes-dashboard.log}"

if [[ ! "${JOSHU_HERMES_DASHBOARD_ENABLED:-true}" =~ ^(1|true|yes)$ ]]; then
  echo "[hermes-dashboard] disabled (JOSHU_HERMES_DASHBOARD_ENABLED=false)"
  exit 0
fi

if ! command -v "${HERMES_BIN}" >/dev/null 2>&1; then
  echo "[hermes-dashboard] ${HERMES_BIN} not found" >&2
  exit 1
fi

hermes_web_dist="${HERMES_DIR}/hermes_cli/web_dist/index.html"
if [[ ! -f "${hermes_web_dist}" ]]; then
  echo "[hermes-dashboard] web_dist missing; building Hermes dashboard frontend (first boot)"
  if command -v npm >/dev/null 2>&1 && [[ -d "${HERMES_DIR}/web" ]]; then
    (
      cd "${HERMES_DIR}/web"
      npm install --include=dev
      npm run build
    ) || {
      echo "[hermes-dashboard] web UI build failed — install dev deps in ${HERMES_DIR}/web" >&2
      exit 1
    }
  else
    echo "[hermes-dashboard] npm or ${HERMES_DIR}/web missing; cannot build dashboard UI" >&2
    exit 1
  fi
fi

health_url="http://${HERMES_DASHBOARD_HOST}:${HERMES_DASHBOARD_PORT}/api/status"

if curl -fsS "${health_url}" >/dev/null 2>&1; then
  echo "[hermes-dashboard] already healthy at ${health_url}"
  exit 0
fi

if [[ -f "${HERMES_DASHBOARD_PID_FILE}" ]]; then
  old_pid="$(cat "${HERMES_DASHBOARD_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "[hermes-dashboard] stopping stale process (pid ${old_pid})"
    kill "${old_pid}" 2>/dev/null || true
    sleep 0.5
    kill -9 "${old_pid}" 2>/dev/null || true
  fi
  rm -f "${HERMES_DASHBOARD_PID_FILE}"
fi

mkdir -p "${HERMES_HOME}" "$(dirname "${HERMES_DASHBOARD_LOG_FILE}")"

export HERMES_HOME
# Subpath deployment — Joshu sets this from CUSTOMER_DOMAIN + PUBLIC_BASE_PATH.
if [[ -n "${HERMES_DASHBOARD_PUBLIC_URL:-}" ]]; then
  export HERMES_DASHBOARD_PUBLIC_URL
fi

echo "[hermes-dashboard] starting on http://${HERMES_DASHBOARD_HOST}:${HERMES_DASHBOARD_PORT} (log: ${HERMES_DASHBOARD_LOG_FILE})"
nohup "${HERMES_BIN}" dashboard \
  --host "${HERMES_DASHBOARD_HOST}" \
  --port "${HERMES_DASHBOARD_PORT}" \
  --no-open \
  >>"${HERMES_DASHBOARD_LOG_FILE}" 2>&1 &
server_pid=$!
printf '%s\n' "${server_pid}" > "${HERMES_DASHBOARD_PID_FILE}"

for _ in $(seq 1 "${HERMES_DASHBOARD_STARTUP_ATTEMPTS:-120}"); do
  if curl -fsS "${health_url}" >/dev/null 2>&1; then
    echo "[hermes-dashboard] healthy at ${health_url}"
    exit 0
  fi
  if ! kill -0 "${server_pid}" >/dev/null 2>&1; then
    echo "[hermes-dashboard] exited before becoming healthy; recent log follows" >&2
    tail -n 80 "${HERMES_DASHBOARD_LOG_FILE}" >&2 || true
    wait "${server_pid}"
    exit 1
  fi
  sleep 1
done

echo "[hermes-dashboard] timed out waiting for ${health_url}" >&2
tail -n 80 "${HERMES_DASHBOARD_LOG_FILE}" >&2 || true
exit 1
