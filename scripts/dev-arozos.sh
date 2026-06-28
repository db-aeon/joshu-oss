#!/usr/bin/env bash
# Local parity dev runner: Camofox on localhost, Joshu private at /joshu, ArozOS public at /.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load_env_file() {
  local env_file="$1"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

load_env_file "${ROOT_DIR}/.env"

# Branded ArozOS shell (Work Sans, paper chrome, taskbar) requires joshu-design overlays.
resolve_joshu_design_pack() {
  if [[ -n "${JOSHU_DESIGN_PACK:-}" && -d "${JOSHU_DESIGN_PACK}/arozos/web-overlays" ]]; then
    export JOSHU_DESIGN_PACK
    return 0
  fi
  local sibling="${ROOT_DIR}/../joshu-design"
  if [[ -d "${sibling}/arozos/web-overlays" ]]; then
    export JOSHU_DESIGN_PACK="${sibling}"
    echo "[dev-arozos] JOSHU_DESIGN_PACK=${JOSHU_DESIGN_PACK} (auto-detected sibling repo)"
    return 0
  fi
  echo "[dev-arozos] JOSHU_DESIGN_PACK not set — using vanilla ArozOS shell (OSS). For branded chrome, clone joshu-design alongside joshu/ or set JOSHU_DESIGN_PACK."
}

resolve_joshu_design_pack

LOCAL_DIR="${ROOT_DIR}/.local"
VENDORED_AROZOS_SOURCE="${ROOT_DIR}/vendor/arozos"
AROZOS_REPO="${AROZOS_REPO:-https://github.com/tobychui/arozos.git}"
AROZOS_REF="${AROZOS_REF:-master}"
if [[ -z "${AROZOS_SOURCE_DIR:-}" ]]; then
  if [[ -d "${VENDORED_AROZOS_SOURCE}/src" ]]; then
    AROZOS_SOURCE_DIR="${VENDORED_AROZOS_SOURCE}"
  else
    AROZOS_SOURCE_DIR="${LOCAL_DIR}/arozos-source"
  fi
fi
AROZ_TEMPLATE="${AROZ_TEMPLATE:-${LOCAL_DIR}/arozos-template-source}"
AROZ_DATA="${AROZ_DATA:-${LOCAL_DIR}/arozos-data}"

PUBLIC_AROZ_PORT="${PUBLIC_AROZ_PORT:-8787}"
JOSHU_PORT="${JOSHU_PORT:-8788}"
PUBLIC_BASE_PATH="${PUBLIC_BASE_PATH:-/joshu}"
JOSHU_HEALTH_URL="${JOSHU_HEALTH_URL:-http://127.0.0.1:${JOSHU_PORT}${PUBLIC_BASE_PATH}/api/status}"
CAMOFOX_URL="${CAMOFOX_URL:-http://127.0.0.1:9377}"
NOVNC_PROXY_TARGET="${NOVNC_PROXY_TARGET:-http://127.0.0.1:6080}"
CAMOFOX_CONTAINER="${CAMOFOX_CONTAINER:-camofox-hitl}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
# shellcheck source=lib/arozos-desktop-shortcuts.sh
source "${ROOT_DIR}/scripts/lib/arozos-desktop-shortcuts.sh"
ICON_TEST_SHORTCUT_CONTENT=$'module\nIcon Test\nIcon Test\nimg/joshu/icon-test.png\n'
PLACEHOLDER_IMAGE_SHORTCUT_CONTENT=$'module\nPictures\nPictures\nimg/joshu/pictures.png\n'

load_env_file "${HERMES_HOME}/.env"

echo "[dev-arozos] starting local parity stack from ${ROOT_DIR}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[dev-arozos] missing required command: $1" >&2
    exit 1
  fi
}

# Hermes search_files (and content search) prefer ripgrep over find.
require_ripgrep() {
  if command -v rg >/dev/null 2>&1; then
    return 0
  fi
  echo "[dev-arozos] missing ripgrep (rg) on PATH — Hermes search_files needs it" >&2
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "[dev-arozos] install: brew install ripgrep" >&2
  else
    echo "[dev-arozos] install: apt install ripgrep  (or your distro equivalent)" >&2
  fi
  exit 1
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"
  for _ in $(seq 1 "${attempts}"); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "[dev-arozos] ${label} is healthy (${url})"
      return 0
    fi
    sleep 1
  done
  echo "[dev-arozos] timed out waiting for ${label}: ${url}" >&2
  return 1
}

start_hindsight_if_needed() {
  export HINDSIGHT_API_HOST="${HINDSIGHT_API_HOST:-127.0.0.1}"
  export HINDSIGHT_API_PORT="${HINDSIGHT_API_PORT:-8888}"
  export HINDSIGHT_API_URL="${HINDSIGHT_API_URL:-http://${HINDSIGHT_API_HOST}:${HINDSIGHT_API_PORT}}"
  export HINDSIGHT_LOG_FILE="${HINDSIGHT_LOG_FILE:-${LOCAL_DIR}/hindsight/hindsight-api.log}"
  export HINDSIGHT_PID_FILE="${HINDSIGHT_PID_FILE:-${LOCAL_DIR}/hindsight/hindsight.pid}"

  if [[ -z "${HINDSIGHT_API_BIN:-}" && -n "${HERMES_BIN:-}" ]]; then
    local hermes_venv_bin
    hermes_venv_bin="$(dirname "${HERMES_BIN}")/hindsight-api"
    if [[ -x "${hermes_venv_bin}" ]]; then
      export HINDSIGHT_API_BIN="${hermes_venv_bin}"
    fi
  fi

  bash "${ROOT_DIR}/scripts/start-hindsight.sh"
}

start_gbrain_if_needed() {
  export APP_DIR="${ROOT_DIR}"
  export AROZ_DATA
  export GBRAIN_HOME="${GBRAIN_HOME:-${LOCAL_DIR}/gbrain}"
  export GBRAIN_LOG_FILE="${GBRAIN_LOG_FILE:-${GBRAIN_HOME}/gbrain-sync.log}"
  export GBRAIN_PID_FILE="${GBRAIN_PID_FILE:-${GBRAIN_HOME}/gbrain-sync.pid}"
  export GBRAIN_MCP_HTTP_PID_FILE="${GBRAIN_MCP_HTTP_PID_FILE:-${GBRAIN_HOME}/gbrain-mcp-http.pid}"
  export GBRAIN_MCP_HTTP_URL="${GBRAIN_MCP_HTTP_URL:-http://127.0.0.1:8794}"
  export PATH="${HOME}/.bun/bin:${PATH}"
  bash "${ROOT_DIR}/scripts/install-gbrain.sh"
  export GBRAIN_BIN="${GBRAIN_BIN:-$(command -v gbrain)}"
  bash "${ROOT_DIR}/scripts/start-gbrain.sh"
  bash "${ROOT_DIR}/scripts/start-gbrain-mcp-http.sh"
  bash "${ROOT_DIR}/scripts/start-joshu-connectors-mcp.sh"
  if [[ "${JOSHU_ACTION_GUARD_ENABLED:-false}" =~ ^(1|true|yes)$ ]] || [[ -n "${COMPOSIO_API_KEY:-}" ]]; then
    bash "${ROOT_DIR}/scripts/start-composio-mcp-guard.sh" || true
  fi
}

start_hermes_dashboard_if_needed() {
  if [[ ! "${JOSHU_HERMES_DASHBOARD_ENABLED:-true}" =~ ^(1|true|yes)$ ]]; then
    return 0
  fi
  export APP_DIR="${ROOT_DIR}"
  export HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
  export HERMES_BIN="${HERMES_BIN:-}"
  if [[ -z "${HERMES_DIR:-}" && -n "${HERMES_BIN}" && -x "${HERMES_BIN}" ]]; then
    export HERMES_DIR="$(cd "$(dirname "${HERMES_BIN}")/../.." && pwd)"
  fi
  bash "${ROOT_DIR}/scripts/start-hermes-dashboard.sh" || true
}

start_web_voice_if_needed() {
  if [[ "${JOSHU_WEB_VOICE_ENABLED:-true}" == "false" ]]; then
    return 0
  fi
  local openai_key="${OPENAI_API_KEY:-${VOICE_TOOLS_OPENAI_KEY:-}}"
  local gemini_key="${GEMINI_API_KEY:-${GOOGLE_API_KEY:-${GOOGLE_GENAI_API_KEY:-}}}"
  local voice_provider="${JOSHU_VOICE_PROVIDER:-openai}"
  local hermes_key="${HERMES_API_KEY:-${API_SERVER_KEY:-}}"
  local voice_key_ok=false
  if [[ "${voice_provider}" == "gemini_live" ]]; then
    [[ -n "${gemini_key}" ]] && voice_key_ok=true
  else
    [[ -n "${openai_key}" ]] && voice_key_ok=true
  fi
  if [[ "${voice_key_ok}" != "true" || -z "${hermes_key}" ]]; then
    if [[ "${voice_provider}" == "gemini_live" ]]; then
      echo "[dev-arozos] web voice skipped (set GEMINI_API_KEY + HERMES_API_KEY for gemini_live)"
    else
      echo "[dev-arozos] web voice skipped (set OPENAI_API_KEY or VOICE_TOOLS_OPENAI_KEY + HERMES_API_KEY)"
    fi
    return 0
  fi
  export TWILIO_MEDIA_STREAM_SECRET="${TWILIO_MEDIA_STREAM_SECRET:-${JOSHU_WEB_VOICE_TOKEN:-${hermes_key}}}"
  export HERMES_API_KEY="${hermes_key}"
  [[ -n "${openai_key}" ]] && export OPENAI_API_KEY="${openai_key}"
  [[ -n "${gemini_key}" ]] && export GEMINI_API_KEY="${gemini_key}"
  export JOSHU_VOICE_MODE="${JOSHU_VOICE_MODE:-realtime_s2s}"

  echo "[dev-arozos] starting voice-realtime on :8792 (${voice_provider})"
  (
    cd "${ROOT_DIR}"
    exec npm run voice-realtime:dev
  ) &
  VOICE_REALTIME_PID=$!
  wait_for_url "voice-realtime" "http://127.0.0.1:8792/health" 30 || true
}

install_icon_test_shortcuts() {
  local template_shortcut="${AROZ_DATA}/system/desktop/template/Icon Test.shortcut"
  mkdir -p "$(dirname "${template_shortcut}")"
  printf '%s' "${ICON_TEST_SHORTCUT_CONTENT}" > "${template_shortcut}"

  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    if [[ -d "${user_desktop}" ]]; then
      printf '%s' "${ICON_TEST_SHORTCUT_CONTENT}" > "${user_desktop}/Icon Test.shortcut"
      chmod 755 "${user_desktop}/Icon Test.shortcut" || true
    fi
  done
}

install_placeholder_image_shortcuts() {
  local template_shortcut="${AROZ_DATA}/system/desktop/template/Pictures.shortcut"
  mkdir -p "$(dirname "${template_shortcut}")"
  printf '%s' "${PLACEHOLDER_IMAGE_SHORTCUT_CONTENT}" > "${template_shortcut}"

  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    if [[ -d "${user_desktop}" ]]; then
      printf '%s' "${PLACEHOLDER_IMAGE_SHORTCUT_CONTENT}" > "${user_desktop}/Pictures.shortcut"
      chmod 755 "${user_desktop}/Pictures.shortcut" || true
    fi
  done
}

start_local_camofox_if_needed() {
  require_command docker
  bash "${ROOT_DIR}/scripts/ensure-camofox-container.sh"
}

prepare_hermes_kanban_ws_patch() {
  if [[ ! -f "${ROOT_DIR}/scripts/apply-hermes-kanban-ws-base-path-patch.sh" ]]; then
    return 0
  fi
  local hermes_dir="${HERMES_DIR:-}"
  if [[ -z "${hermes_dir}" && -n "${HERMES_BIN:-}" ]]; then
    hermes_dir="$(cd "$(dirname "${HERMES_BIN}")/.." && pwd)"
  fi
  if [[ -f "${hermes_dir}/plugins/kanban/dashboard/dist/index.js" ]]; then
    HERMES_DIR="${hermes_dir}" bash "${ROOT_DIR}/scripts/apply-hermes-kanban-ws-base-path-patch.sh" || true
  fi
}

prepare_hermes_langfuse_system_patch() {
  if [[ ! -f "${ROOT_DIR}/scripts/apply-hermes-langfuse-patches.sh" ]]; then
    return 0
  fi
  local hermes_dir="${HERMES_DIR:-}"
  if [[ -z "${hermes_dir}" && -n "${HERMES_BIN:-}" ]]; then
    hermes_dir="$(cd "$(dirname "${HERMES_BIN}")/.." && pwd)"
  fi
  if [[ -f "${hermes_dir}/plugins/observability/langfuse/__init__.py" ]]; then
    HERMES_DIR="${hermes_dir}" bash "${ROOT_DIR}/scripts/apply-hermes-langfuse-patches.sh" || true
  fi
}

prepare_hermes_hitl_browser_patch() {
  if [[ ! -x "${ROOT_DIR}/scripts/apply-hermes-hitl-patch.sh" ]]; then
    return 0
  fi
  local hermes_dir="${HERMES_DIR:-}"
  if [[ -z "${hermes_dir}" && -n "${HERMES_BIN:-}" ]]; then
    hermes_dir="$(cd "$(dirname "${HERMES_BIN}")/.." && pwd)"
  fi
  if [[ -f "${hermes_dir}/tools/browser_camofox.py" ]]; then
    HERMES_DIR="${hermes_dir}" bash "${ROOT_DIR}/scripts/apply-hermes-hitl-patch.sh" || true
  fi
}

prepare_hermes_content_filter_patch() {
  if [[ ! -x "${ROOT_DIR}/scripts/apply-hermes-content-filter-patch.sh" ]]; then
    return 0
  fi
  local hermes_dir="${HERMES_DIR:-}"
  if [[ -z "${hermes_dir}" && -n "${HERMES_BIN:-}" ]]; then
    hermes_dir="$(cd "$(dirname "${HERMES_BIN}")/.." && pwd)"
  fi
  if [[ -f "${hermes_dir}/run_agent.py" ]]; then
    HERMES_DIR="${hermes_dir}" bash "${ROOT_DIR}/scripts/apply-hermes-content-filter-patch.sh" || true
  fi
}

prepare_hermes_invoke_tool_post_hook_patch() {
  if [[ ! -x "${ROOT_DIR}/scripts/apply-hermes-invoke-tool-post-hook-patch.sh" ]]; then
    return 0
  fi
  local hermes_dir="${HERMES_DIR:-}"
  if [[ -z "${hermes_dir}" && -n "${HERMES_BIN:-}" ]]; then
    hermes_dir="$(cd "$(dirname "${HERMES_BIN}")/.." && pwd)"
  fi
  if [[ -f "${hermes_dir}/run_agent.py" ]]; then
    HERMES_DIR="${hermes_dir}" bash "${ROOT_DIR}/scripts/apply-hermes-invoke-tool-post-hook-patch.sh" || true
  fi
}

prepare_arozos_template() {
  require_command git
  require_command go
  require_command npm
  require_command rsync

  mkdir -p "${LOCAL_DIR}"
  if [[ ! -d "${AROZOS_SOURCE_DIR}/.git" ]]; then
    echo "[dev-arozos] ArozOS source not found at ${AROZOS_SOURCE_DIR}"
    echo "[dev-arozos] cloning bootstrap source ${AROZOS_REPO} (${AROZOS_REF}) into ${AROZOS_SOURCE_DIR}"
    echo "[dev-arozos] for product work, add your private ArozOS mirror as vendor/arozos"
    rm -rf "${AROZOS_SOURCE_DIR}"
    git clone "${AROZOS_REPO}" "${AROZOS_SOURCE_DIR}"
    (
      cd "${AROZOS_SOURCE_DIR}"
      git checkout "${AROZOS_REF}"
    )
  else
    echo "[dev-arozos] using ArozOS source at ${AROZOS_SOURCE_DIR}"
  fi

  if [[ ! -d "${AROZOS_SOURCE_DIR}/src/web" || ! -d "${AROZOS_SOURCE_DIR}/src/system" ]]; then
    echo "[dev-arozos] ${AROZOS_SOURCE_DIR} does not look like an ArozOS source checkout (missing src/web or src/system)" >&2
    exit 1
  fi

  echo "[dev-arozos] building ArozOS from source"
  bash "${ROOT_DIR}/scripts/apply-arozos-patches.sh"
  rm -rf "${AROZ_TEMPLATE}"
  mkdir -p "${AROZ_TEMPLATE}/subservice"
  (
    cd "${AROZOS_SOURCE_DIR}/src"
    go mod download
    go build -o "${AROZ_TEMPLATE}/arozos" .
  )
  rsync -a "${AROZOS_SOURCE_DIR}/src/web/" "${AROZ_TEMPLATE}/web/"
  python3 "${ROOT_DIR}/scripts/apply_arozos_joshu_theme.py" "${AROZ_TEMPLATE}/web"
  rsync -a "${AROZOS_SOURCE_DIR}/src/system/" "${AROZ_TEMPLATE}/system/"
  rsync -a "${ROOT_DIR}/arozos/subservice/joshu/" "${AROZ_TEMPLATE}/subservice/joshu/"
  rsync -a "${ROOT_DIR}/arozos/subservice/excalidraw/" "${AROZ_TEMPLATE}/subservice/excalidraw/"
  rsync -a "${ROOT_DIR}/arozos/subservice/hermes-chat/" "${AROZ_TEMPLATE}/subservice/hermes-chat/"
  rsync -a "${ROOT_DIR}/arozos/subservice/hindsight-viewer/" "${AROZ_TEMPLATE}/subservice/hindsight-viewer/"
  rsync -a "${ROOT_DIR}/arozos/subservice/file-brain-viewer/" "${AROZ_TEMPLATE}/subservice/file-brain-viewer/"
  rsync -a "${ROOT_DIR}/arozos/subservice/schedules/" "${AROZ_TEMPLATE}/subservice/schedules/"
  rsync -a "${ROOT_DIR}/arozos/subservice/icon-test/" "${AROZ_TEMPLATE}/subservice/icon-test/"
  rsync -a "${ROOT_DIR}/arozos/subservice/jmovie/" "${AROZ_TEMPLATE}/subservice/jmovie/"
  rsync -a "${ROOT_DIR}/arozos/subservice/jmail/" "${AROZ_TEMPLATE}/subservice/jmail/"
  rsync -a "${ROOT_DIR}/arozos/subservice/connectors/" "${AROZ_TEMPLATE}/subservice/connectors/"
  rsync -a "${ROOT_DIR}/arozos/subservice/safety-settings/" "${AROZ_TEMPLATE}/subservice/safety-settings/"
  rsync -a "${ROOT_DIR}/arozos/subservice/welcome/" "${AROZ_TEMPLATE}/subservice/welcome/"
  rsync -a "${ROOT_DIR}/arozos/subservice/placeholder-image/" "${AROZ_TEMPLATE}/subservice/placeholder-image/"
  bash "${ROOT_DIR}/scripts/install-proprietary-apps.sh" "${AROZ_TEMPLATE}/subservice"
  (
    cd "${ROOT_DIR}"
    npm run build:excalidraw
    npm run build:hermes-chat
    npm run build:hindsight-viewer
    npm run build:file-brain-viewer
    npm run build:schedules
    npm run build:movie-editor
    npm run build:jmail
    npm run build:connectors
    npm run build:safety-settings
    npm run build:welcome
  )
  mkdir -p "${AROZ_TEMPLATE}/subservice/excalidraw/app"
  rsync -a --delete "${ROOT_DIR}/dist/excalidraw/" "${AROZ_TEMPLATE}/subservice/excalidraw/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/hermes-chat/app"
  rsync -a --delete "${ROOT_DIR}/dist/hermes-chat/" "${AROZ_TEMPLATE}/subservice/hermes-chat/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/hindsight-viewer/app"
  rsync -a --delete "${ROOT_DIR}/dist/hindsight-viewer/" "${AROZ_TEMPLATE}/subservice/hindsight-viewer/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/file-brain-viewer/app"
  rsync -a --delete "${ROOT_DIR}/dist/file-brain-viewer/" "${AROZ_TEMPLATE}/subservice/file-brain-viewer/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/schedules/app"
  rsync -a --delete "${ROOT_DIR}/dist/schedules/" "${AROZ_TEMPLATE}/subservice/schedules/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/jmovie/app"
  rsync -a --delete "${ROOT_DIR}/dist/movie-editor/" "${AROZ_TEMPLATE}/subservice/jmovie/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/jmail/app"
  rsync -a --delete "${ROOT_DIR}/dist/jmail/" "${AROZ_TEMPLATE}/subservice/jmail/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/connectors/app"
  rsync -a --delete "${ROOT_DIR}/dist/connectors-app/" "${AROZ_TEMPLATE}/subservice/connectors/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/safety-settings/app"
  rsync -a --delete "${ROOT_DIR}/dist/safety-settings/" "${AROZ_TEMPLATE}/subservice/safety-settings/app/"
  mkdir -p "${AROZ_TEMPLATE}/subservice/welcome/app"
  rsync -a --delete "${ROOT_DIR}/dist/welcome/" "${AROZ_TEMPLATE}/subservice/welcome/app/"
  chmod +x "${AROZ_TEMPLATE}/subservice/joshu/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/excalidraw/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/hermes-chat/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/hindsight-viewer/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/file-brain-viewer/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/schedules/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/icon-test/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/jmovie/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/jmail/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/connectors/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/safety-settings/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/welcome/start.sh"
  chmod +x "${AROZ_TEMPLATE}/subservice/placeholder-image/start.sh"
}

prepare_arozos_data() {
  mkdir -p "${AROZ_DATA}"
  if [[ ! -f "${AROZ_DATA}/.joshu-bootstrapped" ]]; then
    echo "[dev-arozos] first local ArozOS boot: copying template into ${AROZ_DATA}"
    rsync -a "${AROZ_TEMPLATE}/" "${AROZ_DATA}/"
    touch "${AROZ_DATA}/.joshu-bootstrapped"
  fi

  mkdir -p "${AROZ_DATA}/files"
  sync_joshu_aroz_subservices_from_template "${AROZ_TEMPLATE}"
  # ArozOS skips subservices with a .disabled marker; ensure jWeb stays registered.
  rm -f "${AROZ_DATA}/subservice/joshu/.disabled"
  rsync -a "${AROZ_TEMPLATE}/subservice/icon-test/" "${AROZ_DATA}/subservice/icon-test/"
  rsync -a "${AROZ_TEMPLATE}/subservice/placeholder-image/" "${AROZ_DATA}/subservice/placeholder-image/"
  # Re-apply shell theme after rsync so desktop.html always links aroz-paper-shell.css.
  python3 "${ROOT_DIR}/scripts/apply_arozos_joshu_theme.py" "${AROZ_DATA}/web/"
  install_all_joshu_desktop_shortcuts
  install_icon_test_shortcuts
  install_placeholder_image_shortcuts
}

cleanup() {
  local code=$?
  if [[ -n "${HINDSIGHT_PID_FILE:-}" && -f "${HINDSIGHT_PID_FILE}" ]]; then
    local hindsight_pid
    read -r hindsight_pid < "${HINDSIGHT_PID_FILE}" || true
    if [[ -n "${hindsight_pid:-}" ]] && kill -0 "${hindsight_pid}" >/dev/null 2>&1; then
      kill "${hindsight_pid}" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "${VOICE_REALTIME_PID:-}" ]] && kill -0 "${VOICE_REALTIME_PID}" >/dev/null 2>&1; then
    kill "${VOICE_REALTIME_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${JOSHU_PID:-}" ]] && kill -0 "${JOSHU_PID}" >/dev/null 2>&1; then
    kill "${JOSHU_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${AROZ_PID:-}" ]] && kill -0 "${AROZ_PID}" >/dev/null 2>&1; then
    kill "${AROZ_PID}" >/dev/null 2>&1 || true
  fi
  export GBRAIN_HOME="${GBRAIN_HOME:-${LOCAL_DIR}/gbrain}"
  export GBRAIN_PID_FILE="${GBRAIN_PID_FILE:-${GBRAIN_HOME}/gbrain-sync.pid}"
  bash "${ROOT_DIR}/scripts/stop-gbrain.sh" >/dev/null 2>&1 || true
  exit "${code}"
}
trap cleanup EXIT INT TERM

require_ripgrep
prepare_hermes_hitl_browser_patch
prepare_hermes_langfuse_system_patch
prepare_hermes_content_filter_patch
prepare_hermes_invoke_tool_post_hook_patch
prepare_hermes_kanban_ws_patch
start_local_camofox_if_needed
start_hindsight_if_needed
prepare_arozos_template
prepare_arozos_data
start_gbrain_if_needed
start_web_voice_if_needed

echo "[dev-arozos] starting Joshu on 127.0.0.1:${JOSHU_PORT} (base ${PUBLIC_BASE_PATH})"
(
  cd "${ROOT_DIR}"
  export HERMES_HOME
  export HOST="${HOST:-127.0.0.1}"
  export PORT="${JOSHU_PORT}"
  export PUBLIC_AROZ_PORT
  export JOSHU_VOICE_WSS_HOST="${JOSHU_VOICE_WSS_HOST:-127.0.0.1:${JOSHU_PORT}}"
  export PUBLIC_BASE_PATH
  export CAMOFOX_URL
  export NOVNC_URL="${NOVNC_URL:-/novnc}"
  export NOVNC_PROXY_TARGET
  export NOVNC_CLIENT_PATH="${NOVNC_CLIENT_PATH:-/novnc}"
  export HERMES_API_AUTO_START="${HERMES_API_AUTO_START:-true}"
  export JOSHU_HERMES_SKILLS_DIR="${JOSHU_HERMES_SKILLS_DIR:-${ROOT_DIR}/integrations/hermes/skills}"
  export HERMES_ENABLE_PROJECT_PLUGINS="${HERMES_ENABLE_PROJECT_PLUGINS:-true}"
  export AROZ_DATA
  export GBRAIN_HOME="${GBRAIN_HOME:-${LOCAL_DIR}/gbrain}"
  exec ${JOSHU_DEV_CMD:-npx tsx watch src/server.ts}
) &
JOSHU_PID=$!

wait_for_url "Joshu" "${JOSHU_HEALTH_URL}" 90
start_hermes_dashboard_if_needed

echo "[dev-arozos] starting ArozOS on http://127.0.0.1:${PUBLIC_AROZ_PORT}"
(
  cd "${AROZ_DATA}"
  export JOSHU_APP_DIR="${ROOT_DIR}"
  export JOSHU_UPSTREAM="http://127.0.0.1:${JOSHU_PORT}"
  export JOSHU_UPSTREAM_BASE_PATH="${PUBLIC_BASE_PATH}"
  exec "${AROZ_TEMPLATE}/arozos" \
    -port="${PUBLIC_AROZ_PORT}" \
    -disable_ip_resolver=true \
    -hostname="${AROZ_HOSTNAME:-Joshu-HITL-Local}" \
    -tmp="${AROZ_DATA}" \
    -root="${AROZ_DATA}/files"
) &
AROZ_PID=$!

echo "[dev-arozos] open http://127.0.0.1:${PUBLIC_AROZ_PORT}"
wait "${AROZ_PID}"
