#!/usr/bin/env bash
# VPS entrypoint: Camofox + Hindsight + Joshu + ArozOS (VPS parity, durable Postgres).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/joshu}"
CAMOFOX_APP_DIR="${CAMOFOX_APP_DIR:-/app}"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
HINDSIGHT_HOME="${HINDSIGHT_HOME:-/home/hindsight/.hindsight}"
HINDSIGHT_RUN_AS_USER="${HINDSIGHT_RUN_AS_USER:-hindsight}"
HINDSIGHT_LOCAL_DATABASE_URL="${HINDSIGHT_LOCAL_DATABASE_URL:-postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight}"
HINDSIGHT_POSTGRES_BIN_DIR="${HINDSIGHT_POSTGRES_BIN_DIR:-/usr/lib/postgresql/15/bin}"
HINDSIGHT_POSTGRES_DATA_DIR="${HINDSIGHT_POSTGRES_DATA_DIR:-/var/lib/postgresql/hindsight/data}"
HINDSIGHT_POSTGRES_LOG_FILE="${HINDSIGHT_POSTGRES_LOG_FILE:-/var/lib/postgresql/hindsight/postgres.log}"
AROZ_TEMPLATE="${AROZ_TEMPLATE:-/opt/arozos-template}"
AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
JOSHU_PORT="${JOSHU_PORT:-8788}"
PUBLIC_BASE_PATH="${PUBLIC_BASE_PATH:-/joshu}"
JOSHU_HEALTH_URL="${JOSHU_HEALTH_URL:-http://127.0.0.1:${JOSHU_PORT}${PUBLIC_BASE_PATH}/api/instance/health}"
PUBLIC_AROZ_PORT="${PUBLIC_AROZ_PORT:-8787}"

load_env_file() {
  local env_file="$1"
  [[ -f "${env_file}" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
}

# instance.env (provisioned secrets) must override stale keys in the persistent Hermes volume.
load_env_file "${HERMES_HOME}/.env"
load_env_file "/etc/joshu/instance.env"

# gbrain CLI is installed via Bun; the /usr/local/bin/gbrain symlink uses #!/usr/bin/env bun.
export PATH="${HOME}/.bun/bin:/usr/local/bin:${PATH}"
export GBRAIN_BIN="${GBRAIN_BIN:-$(command -v gbrain 2>/dev/null || echo "${HOME}/.bun/bin/gbrain")}"

# Hindsight runs as ${HINDSIGHT_RUN_AS_USER}; GCP service-account JSON must be group-readable.
fix_hindsight_secrets_permissions() {
  local secrets_dir="/etc/joshu/secrets"
  local sa_key="${HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY:-}"
  [[ -n "${sa_key}" && -f "${sa_key}" ]] || return 0
  if ! id "${HINDSIGHT_RUN_AS_USER}" >/dev/null 2>&1; then
    return 0
  fi
  local h_gid
  h_gid="$(id -g "${HINDSIGHT_RUN_AS_USER}")"
  mkdir -p "${secrets_dir}"
  chown "root:${h_gid}" "${secrets_dir}" "${sa_key}" 2>/dev/null || true
  chmod 750 "${secrets_dir}" 2>/dev/null || true
  chmod 640 "${sa_key}" 2>/dev/null || true
}

fix_hindsight_secrets_permissions

# Idempotent Hermes config for product sandboxes (works even if the image predates ensureJoshuHermesConfig).
ensure_hermes_runtime_config() {
  local config="${HERMES_HOME}/config.yaml"
  local dotenv="${HERMES_HOME}/.env"
  local model="${JOSHU_HERMES_MODEL:-deepseek/deepseek-v4-flash}"
  local provider="${JOSHU_HERMES_PROVIDER:-openrouter}"
  local toolsets="${JOSHU_HERMES_TOOLSETS:-[\"mcp-gbrain\", \"mcp-joshu-connectors\", \"kanban\", \"hermes-cli\", \"browser\"]}"

  mkdir -p "${HERMES_HOME}"

  if [[ ! -f "${config}" ]]; then
    cat >"${config}" <<EOF
skills: {}
EOF
  fi

  if ! grep -q '^model:' "${config}" 2>/dev/null; then
    cat >>"${config}" <<EOF

model:
  default: ${model}
  provider: ${provider}
toolsets:
  - hermes-cli
  - browser
  - mcp-gbrain
EOF
    echo "[vps-start] appended Hermes model block to ${config}"
  else
    sed -i "s|^  default:.*|  default: ${model}|" "${config}"
    sed -i "s|^  provider:.*|  provider: ${provider}|" "${config}"
    echo "[vps-start] updated Hermes model in ${config} (${provider} / ${model})"
  fi

  if [[ -n "${OPENROUTER_API_KEY:-}" || -n "${ANTHROPIC_API_KEY:-}" || -n "${HERMES_API_KEY:-}" || -n "${HERMES_LANGFUSE_PUBLIC_KEY:-}" ]]; then
    local tmp="${HERMES_HOME}/.env.sync"
    grep -v -E '^(OPENROUTER_API_KEY|ANTHROPIC_API_KEY|HERMES_API_KEY|API_SERVER_KEY|HERMES_LANGFUSE_|TELEGRAM_)=' "${dotenv}" 2>/dev/null >"${tmp}" || true
    {
      cat "${tmp}" 2>/dev/null || true
      # Plain KEY=value lines (no bash %q quotes — Hermes/Python dotenv treats those as part of the secret).
      [[ -n "${OPENROUTER_API_KEY:-}" ]] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
      [[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
      [[ -n "${HERMES_API_KEY:-}" ]] && echo "HERMES_API_KEY=${HERMES_API_KEY}"
      [[ -n "${API_SERVER_KEY:-}" ]] && echo "API_SERVER_KEY=${API_SERVER_KEY}"
      [[ -n "${HERMES_LANGFUSE_PUBLIC_KEY:-}" ]] && echo "HERMES_LANGFUSE_PUBLIC_KEY=${HERMES_LANGFUSE_PUBLIC_KEY}"
      [[ -n "${HERMES_LANGFUSE_SECRET_KEY:-}" ]] && echo "HERMES_LANGFUSE_SECRET_KEY=${HERMES_LANGFUSE_SECRET_KEY}"
      [[ -n "${HERMES_LANGFUSE_BASE_URL:-}" ]] && echo "HERMES_LANGFUSE_BASE_URL=${HERMES_LANGFUSE_BASE_URL}"
      [[ -n "${HERMES_LANGFUSE_ENV:-}" ]] && echo "HERMES_LANGFUSE_ENV=${HERMES_LANGFUSE_ENV}"
      [[ -n "${HERMES_LANGFUSE_USER_ID:-}" ]] && echo "HERMES_LANGFUSE_USER_ID=${HERMES_LANGFUSE_USER_ID}"
      [[ -n "${HERMES_LANGFUSE_RELEASE:-}" ]] && echo "HERMES_LANGFUSE_RELEASE=${HERMES_LANGFUSE_RELEASE}"
      [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
      [[ -n "${TELEGRAM_ALLOWED_USERS:-}" ]] && echo "TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS}"
      [[ -n "${TELEGRAM_GROUP_ALLOWED_USERS:-}" ]] && echo "TELEGRAM_GROUP_ALLOWED_USERS=${TELEGRAM_GROUP_ALLOWED_USERS}"
      [[ -n "${TELEGRAM_GROUP_ALLOWED_CHATS:-}" ]] && echo "TELEGRAM_GROUP_ALLOWED_CHATS=${TELEGRAM_GROUP_ALLOWED_CHATS}"
      [[ -n "${TELEGRAM_HOME_CHANNEL:-}" ]] && echo "TELEGRAM_HOME_CHANNEL=${TELEGRAM_HOME_CHANNEL}"
      [[ -n "${TELEGRAM_HOME_CHANNEL_NAME:-}" ]] && echo "TELEGRAM_HOME_CHANNEL_NAME=${TELEGRAM_HOME_CHANNEL_NAME}"
      [[ -n "${TELEGRAM_WEBHOOK_URL:-}" ]] && echo "TELEGRAM_WEBHOOK_URL=${TELEGRAM_WEBHOOK_URL}"
      [[ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ]] && echo "TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}"
    } >"${dotenv}"
    chmod 600 "${dotenv}" 2>/dev/null || true
    rm -f "${tmp}"
    echo "[vps-start] synced Hermes keys into ${dotenv}"
  else
    echo "[vps-start] WARN: OPENROUTER_API_KEY/HERMES_API_KEY missing after loading instance.env" >&2
  fi

  # Enable Langfuse (and other) plugins before gateway start — gateway only reads plugins.enabled at boot.
  if [[ -n "${JOSHU_HERMES_PLUGIN_NAMES:-}" && -x "${HERMES_BIN:-}" ]]; then
    local p
    IFS=',' read -ra _joshu_plugins <<< "${JOSHU_HERMES_PLUGIN_NAMES}"
    for p in "${_joshu_plugins[@]}"; do
      p="${p// /}"
      [[ -n "${p}" ]] || continue
      if "${HERMES_BIN}" plugins enable "${p}" 2>/dev/null; then
        echo "[vps-start] Hermes plugin enabled: ${p}"
      fi
    done
  fi
}

# Gateway reads ~/.hermes/.env at process start; restart if already running with stale env.
# gateway.pid is JSON in current Hermes — see scripts/lib/hermes-gateway.sh.
# shellcheck source=/dev/null
source "${APP_DIR}/scripts/lib/hermes-gateway.sh"

# Control-plane companion persona → identity.json + Hermes SOUL.md (needs ArozOS user paths).
sync_companion_identity() {
  local sync_url="${JOSHU_HEALTH_URL%/api/instance/health}/api/instance/sync-companion-identity"
  if curl -fsS -X POST "${sync_url}" \
    -H "Content-Type: application/json" \
    -d '{"forceSoul":true}' >/dev/null 2>&1; then
    echo "[vps-start] companion identity synced via Joshu API"
    return 0
  fi
  local script="${APP_DIR}/scripts/sync-companion-identity.mjs"
  if [[ -f "${script}" && -f "${APP_DIR}/dist/companionIdentitySync.js" ]]; then
    node "${script}" --force-soul || echo "[vps-start] WARN: sync-companion-identity failed" >&2
  fi
}

apply_hermes_langfuse_patches() {
  local script="${APP_DIR}/scripts/apply-hermes-langfuse-patches.sh"
  [[ -f "${script}" ]] || return 0
  HERMES_DIR="${HERMES_DIR}" bash "${script}" || echo "[vps-start] WARN: Langfuse Hermes patches failed" >&2
}

apply_hermes_kanban_ws_patch() {
  if [[ "${JOSHU_HERMES_DASHBOARD_DIRECT:-true}" =~ ^(1|true|yes)$ ]]; then
    return 0
  fi
  local script="${APP_DIR}/scripts/apply-hermes-kanban-ws-base-path-patch.sh"
  [[ -f "${script}" ]] || return 0
  HERMES_DIR="${HERMES_DIR}" bash "${script}" || echo "[vps-start] WARN: Kanban WebSocket base-path patch failed" >&2
}

apply_hermes_skill_evolution_patch() {
  local script="${APP_DIR}/proprietary/scripts/apply-hermes-skill-evolution-patch.sh"
  [[ -f "${script}" ]] || script="${APP_DIR}/scripts/apply-hermes-skill-evolution-patch.sh"
  [[ -f "${script}" ]] || return 0
  HERMES_DIR="${HERMES_DIR}" bash "${script}" || echo "[vps-start] WARN: skill evolution patch failed" >&2
}

apply_hermes_content_filter_patch() {
  local script="${APP_DIR}/scripts/apply-hermes-content-filter-patch.sh"
  [[ -f "${script}" ]] || return 0
  HERMES_DIR="${HERMES_DIR}" bash "${script}" || echo "[vps-start] WARN: content filter patch failed" >&2
}

bootstrap_hermes_learning_skills() {
  local script="${APP_DIR}/scripts/bootstrap-hermes-learning-skills.sh"
  [[ -f "${script}" ]] || return 0
  HERMES_HOME="${HERMES_HOME}" APP_DIR="${APP_DIR}" bash "${script}" || echo "[vps-start] WARN: hermes learning skills seed failed" >&2
}

# Learning GitHub sync uses deploy-key SSH; older images omitted openssh-client.
ensure_openssh_client_for_learning_sync() {
  if [[ -z "${JOSHU_HERMES_LEARNING_GITHUB_REPO:-}" && -z "${JOSHU_HERMES_LEARNING_GITHUB_REMOTE:-}" ]]; then
    return 0
  fi
  command -v ssh >/dev/null 2>&1 && return 0
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-client \
    || echo "[vps-start] WARN: openssh-client install failed (learning GitHub sync needs ssh)" >&2
}

ensure_hermes_learning_git() {
  local script="${APP_DIR}/scripts/lib/ensure-hermes-learning-git.sh"
  [[ -f "${script}" ]] || return 0
  HERMES_HOME="${HERMES_HOME}" bash "${script}" || echo "[vps-start] WARN: hermes learning git init failed" >&2
}

apply_hermes_langfuse_patches
apply_hermes_kanban_ws_patch
apply_hermes_skill_evolution_patch
apply_hermes_content_filter_patch
bootstrap_hermes_learning_skills
ensure_openssh_client_for_learning_sync
ensure_hermes_learning_git
ensure_hermes_runtime_config
restart_hermes_gateway_if_running

# Image 0.1.6 predates gbrain MCP in dist/hermesApi.js; merge MCP block at boot.
ensure_hermes_gbrain_mcp_config() {
  local script="${APP_DIR}/scripts/ensure-hermes-gbrain-mcp.mjs"
  if [[ ! -f "${script}" ]]; then
    echo "[vps-start] ${script} missing; gbrain MCP not configured" >&2
    return 0
  fi
  export PATH="${HOME}/.bun/bin:/usr/local/bin:${PATH}"
  if [[ -z "${GBRAIN_BIN:-}" ]]; then
    if [[ -x "${HOME}/.bun/bin/gbrain" ]]; then
      export GBRAIN_BIN="${HOME}/.bun/bin/gbrain"
    else
      export GBRAIN_BIN="$(command -v gbrain 2>/dev/null || echo gbrain)"
    fi
  fi
  node "${script}" || echo "[vps-start] WARN: ensure-hermes-gbrain-mcp failed" >&2
}

# Image 0.1.6 dist/hermesApi.js rewrites toolsets on every chat/health warm without mcp-gbrain.
hermes_config_needs_gbrain_fix() {
  local config="${HERMES_HOME}/config.yaml"
  [[ -f "${config}" ]] || return 0
  grep -q 'mcp-gbrain' "${config}" 2>/dev/null || return 0
  grep -q '^  gbrain:' "${config}" 2>/dev/null || return 0
  # Legacy stdio proxy or bare `command: gbrain` — migrate to HTTP MCP.
  grep -A3 '^  gbrain:' "${config}" 2>/dev/null | grep -qE '^    command:' && return 0
  grep -A3 '^  gbrain:' "${config}" 2>/dev/null | grep -qE '^    url:' || return 0
  return 1
}

start_hermes_gbrain_config_watchdog() {
  (
    while true; do
      sleep 20
      if hermes_config_needs_gbrain_fix; then
        echo "[vps-start] re-applying gbrain MCP (legacy hermesApi overwrote config)" >&2
        ensure_hermes_gbrain_mcp_config
        reload_hermes_gateway_after_config_change
      fi
    done
  ) &
}

start_connectors_mcp_watchdog() {
  local port="${JOSHU_CONNECTORS_MCP_PORT:-8795}"
  local health_url="http://127.0.0.1:${port}/health"
  local last_ok=1
  (
    while true; do
      sleep 30
      if curl -fsS "${health_url}" >/dev/null 2>&1; then
        if [[ "${last_ok}" -eq 0 ]]; then
          echo "[vps-start] connectors MCP recovered — nudging Hermes gateway for MCP tool catalog" >&2
          reload_hermes_gateway_after_config_change
        fi
        last_ok=1
      else
        echo "[vps-start] connectors MCP unhealthy — restarting (${health_url})" >&2
        bash "${APP_DIR}/scripts/start-joshu-connectors-mcp.sh" || true
        reload_hermes_gateway_after_config_change
        last_ok=0
      fi
    done
  ) &
}

start_composio_mcp_guard_watchdog() {
  local port="${JOSHU_COMPOSIO_MCP_GUARD_PORT:-8796}"
  local health_url="http://127.0.0.1:${port}/health"
  local last_ok=1
  (
    while true; do
      sleep 30
      if curl -fsS "${health_url}" >/dev/null 2>&1; then
        if [[ "${last_ok}" -eq 0 ]]; then
          echo "[vps-start] composio MCP guard recovered — nudging Hermes gateway" >&2
          reload_hermes_gateway_after_config_change
        fi
        last_ok=1
      else
        echo "[vps-start] composio MCP guard unhealthy — restarting (${health_url})" >&2
        bash "${APP_DIR}/scripts/start-composio-mcp-guard.sh" || true
        reload_hermes_gateway_after_config_change
        last_ok=0
      fi
    done
  ) &
}

wait_for_mcp_http_health() {
  local health_url="$1"
  local label="$2"
  local attempts="${3:-60}"
  local n=0
  while [[ "${n}" -lt "${attempts}" ]]; do
    if curl -fsS "${health_url}" >/dev/null 2>&1; then
      echo "[vps-start] ${label} healthy (${health_url})"
      return 0
    fi
    sleep 1
    n=$((n + 1))
  done
  echo "[vps-start] WARN: ${label} not healthy after ${attempts}s (${health_url})" >&2
  return 1
}

start_gbrain_mcp_with_retries() {
  local attempts="${GBRAIN_MCP_BOOT_RETRIES:-3}"
  local n=1
  while [[ "${n}" -le "${attempts}" ]]; do
    if bash "${APP_DIR}/scripts/start-gbrain-mcp-http.sh"; then
      return 0
    fi
    echo "[vps-start] gbrain MCP HTTP start failed (attempt ${n}/${attempts})" >&2
    if [[ "${n}" -lt "${attempts}" ]]; then
      GBRAIN_REPAIR_PGLITE=1 bash "${APP_DIR}/scripts/repair-gbrain-pglite.sh" || true
      sleep 5
    fi
    n=$((n + 1))
  done
  return 1
}

start_gbrain_stack() {
  export GBRAIN_HOME="${GBRAIN_HOME:-/root/.gbrain}"
  if ! command -v gbrain >/dev/null 2>&1; then
    echo "[vps-start] gbrain missing from image; running install-gbrain.sh"
    bash "${APP_DIR}/scripts/install-gbrain.sh"
  fi
  export GBRAIN_BOOT_QUICK="${GBRAIN_BOOT_QUICK:-true}"
  if ! bash "${APP_DIR}/scripts/start-gbrain.sh"; then
    if [[ "${JOSHU_GBRAIN_OPTIONAL:-true}" =~ ^(1|true|yes)$ ]]; then
      echo "[vps-start] WARN: gbrain quick boot failed; desktop up, file brain may be degraded" >&2
    else
      echo "[vps-start] gbrain failed to start" >&2
      exit 1
    fi
  fi
  export GBRAIN_MCP_HTTP_URL="${GBRAIN_MCP_HTTP_URL:-http://127.0.0.1:8794}"
  if ! start_gbrain_mcp_with_retries; then
    if [[ "${JOSHU_GBRAIN_OPTIONAL:-true}" =~ ^(1|true|yes)$ ]]; then
      echo "[vps-start] WARN: gbrain MCP HTTP failed after retries; continuing" >&2
    else
      echo "[vps-start] gbrain MCP HTTP failed to start" >&2
      exit 1
    fi
  fi
  # MCP HTTP owns the sole PGLite holder (gbrain serve). Do not run a second start-gbrain.sh here —
  # it steals the lock and SIGTERM-kills the MCP child (File Brain shows 0 pages).
  (
    sleep 45
    echo "[vps-start] gbrain catch-up reindex via ensure-gbrain-indexed (soft)"
    bash "${APP_DIR}/scripts/ensure-gbrain-indexed.sh" --soft \
      >>"${GBRAIN_HOME}/gbrain-full-boot.log" 2>&1 || true
  ) >>"${GBRAIN_HOME}/gbrain-full-boot.log" 2>&1 &
  (
    sleep 180
    echo "[vps-start] gbrain index health check (3m)"
    bash "${APP_DIR}/scripts/ensure-gbrain-indexed.sh" \
      >>"${GBRAIN_HOME}/gbrain-full-boot.log" 2>&1 || true
  ) >>"${GBRAIN_HOME}/gbrain-full-boot.log" 2>&1 &
}

start_gbrain_mcp_watchdog() {
  local health_url="${GBRAIN_MCP_HTTP_URL:-http://127.0.0.1:8794}/health"
  (
    local boot_checks=0
    local stuck_sessions=0
    while true; do
      if [[ "${boot_checks}" -lt 40 ]]; then
        sleep 15
        boot_checks=$((boot_checks + 1))
      else
        sleep 60
      fi

      local body=""
      body="$(curl -fsS "${health_url}" 2>/dev/null || true)"
      if [[ -z "${body}" ]] || ! echo "${body}" | grep -q '"ok":true'; then
        stuck_sessions=0
        echo "[vps-start] gbrain MCP HTTP unhealthy — restarting (${health_url})" >&2
        bash "${APP_DIR}/scripts/start-gbrain-mcp-http.sh" || true
        continue
      fi
      if echo "${body}" | grep -q '"session_ready":true'; then
        stuck_sessions=0
        continue
      fi
      stuck_sessions=$((stuck_sessions + 1))
      if [[ "${stuck_sessions}" -ge 20 ]]; then
        echo "[vps-start] gbrain MCP session stuck (no session_ready) — restarting" >&2
        stuck_sessions=0
        bash "${APP_DIR}/scripts/start-gbrain-mcp-http.sh" || true
      fi
    done
  ) &
}

start_gbrain_empty_index_watchdog() {
  local ensure_script="${APP_DIR}/scripts/ensure-gbrain-indexed.sh"
  local interval_sec="${GBRAIN_EMPTY_INDEX_WATCHDOG_SEC:-300}"
  [[ -f "${ensure_script}" ]] || return 0
  (
    while true; do
      sleep "${interval_sec}"
      if [[ -f "${GBRAIN_HOME:-/root/.gbrain}/.joshu-gbrain-needs-full-sync" ]]; then
        echo "[vps-start] gbrain empty-index flag present — running ensure-gbrain-indexed" >&2
        rm -f "${GBRAIN_HOME}/.joshu-gbrain-needs-full-sync" 2>/dev/null || true
        bash "${ensure_script}" >>"${GBRAIN_HOME}/gbrain-ensure-indexed.log" 2>&1 || true
        continue
      fi
      bash "${ensure_script}" --check-only >>"${GBRAIN_HOME}/gbrain-ensure-indexed.log" 2>&1 || {
        echo "[vps-start] gbrain index empty with disk content — ensure-gbrain-indexed" >&2
        bash "${ensure_script}" >>"${GBRAIN_HOME}/gbrain-ensure-indexed.log" 2>&1 || true
      }
    done
  ) &
}

ensure_hermes_gbrain_mcp_config
restart_hermes_gateway_if_running

mkdir -p "${HERMES_HOME}" "${HINDSIGHT_POSTGRES_DATA_DIR}" "$(dirname "${HINDSIGHT_POSTGRES_LOG_FILE}")" "${AROZ_DATA}"

export HOST="${HOST:-127.0.0.1}"
export PORT="${JOSHU_PORT}"
export PUBLIC_BASE_PATH
export CAMOFOX_URL="${CAMOFOX_URL:-http://127.0.0.1:9377}"
export CAMOFOX_AUTO_RESTART="${CAMOFOX_AUTO_RESTART:-false}"
# Camofox image serves noVNC on :6080 when ENABLE_VNC=1 (VPS parity — see deploy/scripts/vps-start.sh).
export ENABLE_VNC="${ENABLE_VNC:-1}"
export NOVNC_PORT="${NOVNC_PORT:-6080}"
export NOVNC_URL="${NOVNC_URL:-/novnc}"
export NOVNC_PROXY_TARGET="${NOVNC_PROXY_TARGET:-http://127.0.0.1:6080}"
export NOVNC_CLIENT_PATH="${NOVNC_CLIENT_PATH:-/novnc}"
export VNC_RESOLUTION="${VNC_RESOLUTION:-1024x768}"
export CAMOFOX_VIEWPORT_WIDTH="${CAMOFOX_VIEWPORT_WIDTH:-1024}"
export CAMOFOX_VIEWPORT_HEIGHT="${CAMOFOX_VIEWPORT_HEIGHT:-768}"
export CAMOFOX_FF_VERSION="${CAMOFOX_FF_VERSION:-139}"
export CAMOFOX_START_URL="${CAMOFOX_START_URL:-about:blank}"
export JOSHU_WARM_CAMOFOX="${JOSHU_WARM_CAMOFOX:-false}"
export HITL_CAMOFOX_USER_ID="${HITL_CAMOFOX_USER_ID:-hitl-camofox}"
export HITL_CAMOFOX_SESSION_KEY="${HITL_CAMOFOX_SESSION_KEY:-hitl-main}"
export HITL_CAMOFOX_SINGLE_TAB="${HITL_CAMOFOX_SINGLE_TAB:-true}"
export CAMOFOX_USER_ID="${CAMOFOX_USER_ID:-${HITL_CAMOFOX_USER_ID}}"
export CAMOFOX_SESSION_KEY="${CAMOFOX_SESSION_KEY:-${HITL_CAMOFOX_SESSION_KEY}}"
export CAMOFOX_ADOPT_EXISTING_TAB="${CAMOFOX_ADOPT_EXISTING_TAB:-true}"
export BROWSER_IDLE_TIMEOUT_MS="${BROWSER_IDLE_TIMEOUT_MS:-300000}"
export SESSION_TIMEOUT_MS="${SESSION_TIMEOUT_MS:-1800000}"
export MAX_TABS_PER_SESSION="${MAX_TABS_PER_SESSION:-1}"
export MAX_TABS_GLOBAL="${MAX_TABS_GLOBAL:-1}"
export CAMOFOX_MAX_TABS="${CAMOFOX_MAX_TABS:-1}"
export HITL_FORCE_SINGLE_VISIBLE_PAGE="${HITL_FORCE_SINGLE_VISIBLE_PAGE:-true}"
export MAX_OLD_SPACE_SIZE="${MAX_OLD_SPACE_SIZE:-256}"
export HERMES_BIN="${HERMES_BIN:-${HERMES_DIR}/venv/bin/hermes}"
export HINDSIGHT_API_BIN="${HINDSIGHT_API_BIN:-${HERMES_DIR}/venv/bin/hindsight-api}"
export HINDSIGHT_API_URL="${HINDSIGHT_API_URL:-http://127.0.0.1:8888}"
export HINDSIGHT_API_DATABASE_URL="${HINDSIGHT_API_DATABASE_URL:-${HINDSIGHT_LOCAL_DATABASE_URL}}"

start_hindsight_postgres_if_needed() {
  [[ "${JOSHU_HINDSIGHT_ENABLED:-false}" == "true" ]] || return 0
  case "${HINDSIGHT_API_DATABASE_URL}" in
    "${HINDSIGHT_LOCAL_DATABASE_URL}"|postgresql://hindsight:hindsight@localhost:5432/hindsight) ;;
    *) echo "[vps-start] external Hindsight DB; skipping local Postgres"; return 0 ;;
  esac
  [[ -x "${HINDSIGHT_POSTGRES_BIN_DIR}/postgres" ]] || return 1
  chown -R postgres:postgres "$(dirname "${HINDSIGHT_POSTGRES_DATA_DIR}")" "$(dirname "${HINDSIGHT_POSTGRES_LOG_FILE}")" 2>/dev/null || true
  if [[ ! -s "${HINDSIGHT_POSTGRES_DATA_DIR}/PG_VERSION" ]]; then
    runuser -u postgres -- "${HINDSIGHT_POSTGRES_BIN_DIR}/initdb" -D "${HINDSIGHT_POSTGRES_DATA_DIR}" --encoding=UTF8 --locale=C.UTF-8
  fi
  if ! runuser -u postgres -- "${HINDSIGHT_POSTGRES_BIN_DIR}/pg_ctl" -D "${HINDSIGHT_POSTGRES_DATA_DIR}" status >/dev/null 2>&1; then
    runuser -u postgres -- "${HINDSIGHT_POSTGRES_BIN_DIR}/pg_ctl" -D "${HINDSIGHT_POSTGRES_DATA_DIR}" \
      -l "${HINDSIGHT_POSTGRES_LOG_FILE}" -o "-c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=/tmp" -w start
  fi
  runuser -u postgres -- "${HINDSIGHT_POSTGRES_BIN_DIR}/psql" -h /tmp -v ON_ERROR_STOP=1 postgres <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hindsight') THEN
    CREATE ROLE hindsight WITH LOGIN PASSWORD 'hindsight';
  END IF;
END $$;
SELECT 'CREATE DATABASE hindsight OWNER hindsight' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hindsight')\gexec
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
SQL
}

ensure_camoufox_browser_cache() {
  if [[ -f /root/.cache/camoufox/version.json ]]; then
    return 0
  fi
  echo "[vps-start] Camoufox browser cache missing; running npx camoufox-js fetch (first boot may take several minutes)"
  (
    cd "${CAMOFOX_APP_DIR}"
    npx --yes camoufox-js fetch
  ) || {
    echo "[vps-start] ERROR: camoufox-js fetch failed; POST /tabs will return 500 until the browser is installed" >&2
    return 1
  }
}

warm_camofox_browser() {
  ensure_camoufox_browser_cache || return 1
  local user="${CAMOFOX_USER_ID}"
  local sk="${CAMOFOX_SESSION_KEY}"
  echo "[vps-start] warming Camofox browser (${user})"
  if curl -fsS -m 120 -X POST "${CAMOFOX_URL}/tabs" \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"${user}\",\"sessionKey\":\"${sk}\",\"url\":\"${CAMOFOX_START_URL}\"}" >/dev/null 2>&1; then
    echo "[vps-start] Camofox browser tab ready"
    return 0
  fi
  echo "[vps-start] WARN: Camofox browser warm-up failed; VNC may connect then drop until a tab exists" >&2
  return 1
}

echo "[vps-start] Camofox ${CAMOFOX_URL}"
( cd "${CAMOFOX_APP_DIR}" && node --max-old-space-size="${MAX_OLD_SPACE_SIZE}" server.js ) &
for _ in $(seq 1 90); do curl -fsS "${CAMOFOX_URL}/health" >/dev/null 2>&1 && break; sleep 1; done
if [[ "${JOSHU_WARM_CAMOFOX}" =~ ^(1|true|yes)$ ]]; then
  warm_camofox_browser || true
else
  echo "[vps-start] Camofox warm-up skipped (JOSHU_WARM_CAMOFOX=false); browser starts on first use"
fi

start_hindsight_postgres_if_needed
if ! bash "${APP_DIR}/scripts/start-hindsight.sh"; then
  if [[ "${JOSHU_HINDSIGHT_OPTIONAL:-true}" =~ ^(1|true|yes)$ ]]; then
    echo "[vps-start] Hindsight did not start; continuing (JOSHU_HINDSIGHT_OPTIONAL)"
  else
    echo "[vps-start] Hindsight required but failed to start" >&2
    exit 1
  fi
fi

if [[ "${AROZOS_ENABLED:-false}" =~ ^(1|true|yes)$ ]]; then
  # shellcheck source=../../scripts/lib/arozos-desktop-shortcuts.sh
  source "${APP_DIR}/scripts/lib/arozos-desktop-shortcuts.sh"

  if [[ ! -f "${AROZ_DATA}/.joshu-bootstrapped" ]]; then
    rsync -a "${AROZ_TEMPLATE}/" "${AROZ_DATA}/"
    touch "${AROZ_DATA}/.joshu-bootstrapped"
  fi
  sync_joshu_aroz_subservices_from_template "${AROZ_TEMPLATE}"

  # ArozOS appends "/tmp/" to -tmp (see vendor/arozos/src/main.go). Use the data parent only.
  AROZ_TMP_ROOT="${AROZ_TMP_ROOT:-${AROZ_DATA}}"
  if [[ "${AROZ_TMP_ROOT}" == */tmp ]]; then
    echo "[vps-start] AROZ_TMP_ROOT must be ${AROZ_DATA}, not ${AROZ_TMP_ROOT} (would become .../tmp/tmp/)" >&2
    exit 1
  fi
  mkdir -p "${AROZ_DATA}/files"
  if [[ -n "${JOSHU_AROZ_USER:-}" ]]; then
    JOSHU_REBIND_SKIP_GBRAIN_START=true bash "${APP_DIR}/scripts/rebind-gbrain-owner.sh" || true
  else
    bash "${APP_DIR}/scripts/bootstrap-joshu-files.sh" || true
  fi
  install_all_joshu_desktop_shortcuts
  python3 "${APP_DIR}/scripts/apply_arozos_joshu_theme.py" "${AROZ_DATA}/web/" || true
  echo "[vps-start] ArozOS :${PUBLIC_AROZ_PORT} (tmp-root=${AROZ_TMP_ROOT})"
  ( cd "${AROZ_DATA}" && "${AROZ_TEMPLATE}/arozos" -port="${PUBLIC_AROZ_PORT}" -disable_ip_resolver=true \
    -hostname="${AROZ_HOSTNAME:-Joshu}" -tmp="${AROZ_TMP_ROOT}" -root="${AROZ_DATA}/files" ) &
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null -w '' "http://127.0.0.1:${PUBLIC_AROZ_PORT}/" 2>/dev/null; then
      echo "[vps-start] ArozOS desktop reachable on :${PUBLIC_AROZ_PORT}"
      break
    fi
    sleep 1
  done
else
  echo "[vps-start] ArozOS disabled; set AROZOS_ENABLED=true after slim image web assets are validated"
fi

# Start gbrain before Joshu so /api/instance/health does not run doctor against a locked PGLite.
start_gbrain_stack

# Hotfix boxes: bind-mounted packages/email-signature may ship before the next image cut.
if [[ -f "${APP_DIR}/packages/email-signature/dist/index.js" ]] \
  && [[ ! -f "${APP_DIR}/node_modules/@joshu/email-signature/dist/index.js" ]]; then
  echo "[vps-start] copying @joshu/email-signature from bind-mounted packages/" >&2
  mkdir -p "${APP_DIR}/node_modules/@joshu"
  rm -rf "${APP_DIR}/node_modules/@joshu/email-signature"
  cp -a "${APP_DIR}/packages/email-signature" "${APP_DIR}/node_modules/@joshu/email-signature"
fi

echo "[vps-start] Joshu ${HOST}:${PORT}"
export JOSHU_DEFER_HERMES_GATEWAY_WARM=true
( cd "${APP_DIR}" && node dist/server.js ) &
JOSHU_PID=$!
for _ in $(seq 1 60); do curl -fsS "${JOSHU_HEALTH_URL}" >/dev/null 2>&1 && break; sleep 1; done
sync_companion_identity

export JOSHU_CONNECTORS_API_BASE="${JOSHU_CONNECTORS_API_BASE:-http://127.0.0.1:8788/joshu}"
if ! bash "${APP_DIR}/scripts/start-joshu-connectors-mcp.sh"; then
  if [[ "${JOSHU_GBRAIN_OPTIONAL:-true}" =~ ^(1|true|yes)$ ]]; then
    echo "[vps-start] WARN: connectors MCP HTTP failed; continuing" >&2
  else
    echo "[vps-start] connectors MCP HTTP failed to start" >&2
    exit 1
  fi
fi
wait_for_mcp_http_health "http://127.0.0.1:${JOSHU_CONNECTORS_MCP_PORT:-8795}/health" "connectors MCP" 60 || true

if [[ "${JOSHU_ACTION_GUARD_ENABLED:-false}" =~ ^(1|true|yes)$ ]] || [[ -n "${COMPOSIO_API_KEY:-}" ]]; then
  if ! bash "${APP_DIR}/scripts/start-composio-mcp-guard.sh"; then
    if [[ "${JOSHU_GBRAIN_OPTIONAL:-true}" =~ ^(1|true|yes)$ ]]; then
      echo "[vps-start] WARN: composio MCP guard failed; continuing" >&2
    else
      echo "[vps-start] composio MCP guard failed to start" >&2
      exit 1
    fi
  fi
  wait_for_mcp_http_health "http://127.0.0.1:${JOSHU_COMPOSIO_MCP_GUARD_PORT:-8796}/health" "composio MCP guard" 60 || true
fi

# Warm Joshu + Hermes only after MCP HTTP deps are up (Hermes registers tools once at gateway boot).
if [[ "${HERMES_API_AUTO_START:-true}" =~ ^(1|true|yes)$ ]]; then
  # Re-sync after Node may have updated ~/.hermes; instance.env values win.
  load_env_file "${HERMES_HOME}/.env"
  load_env_file "/etc/joshu/instance.env"
  ensure_hermes_runtime_config
  # Legacy image dist/hermesApi.js runs on health probes and omits gbrain MCP.
  ensure_hermes_gbrain_mcp_config
  reload_hermes_gateway_after_config_change
fi

if [[ "${JOSHU_HERMES_DASHBOARD_ENABLED:-true}" =~ ^(1|true|yes)$ ]]; then
  if [[ -n "${CUSTOMER_DOMAIN:-}" && -z "${JOSHU_HERMES_DASHBOARD_PASSWORD:-}" ]]; then
    echo "[vps-start] WARN: set JOSHU_HERMES_DASHBOARD_PASSWORD in instance.env (Hermes admin can read/write API keys)" >&2
  fi
  dashboard_public="${HERMES_DASHBOARD_PUBLIC_URL:-}"
  if [[ -z "${dashboard_public}" && -n "${CUSTOMER_DOMAIN:-}" ]]; then
    if [[ "${JOSHU_HERMES_DASHBOARD_DIRECT:-true}" =~ ^(1|true|yes)$ ]]; then
      hermes_host="${HERMES_DASHBOARD_DOMAIN:-hermes-admin.${CUSTOMER_DOMAIN}}"
      export HERMES_DASHBOARD_PUBLIC_URL="https://${hermes_host}"
      export JOSHU_HERMES_DASHBOARD_SHORTCUT_PATH="${HERMES_DASHBOARD_PUBLIC_URL}/"
    else
      export HERMES_DASHBOARD_PUBLIC_URL="https://${CUSTOMER_DOMAIN}${PUBLIC_BASE_PATH}/hermes-admin"
    fi
  elif [[ -n "${dashboard_public}" ]]; then
    export HERMES_DASHBOARD_PUBLIC_URL="${dashboard_public}"
    export JOSHU_HERMES_DASHBOARD_SHORTCUT_PATH="${JOSHU_HERMES_DASHBOARD_SHORTCUT_PATH:-${HERMES_DASHBOARD_PUBLIC_URL}/}"
  fi
  if ! bash "${APP_DIR}/scripts/start-hermes-dashboard.sh"; then
    if [[ "${JOSHU_HERMES_DASHBOARD_OPTIONAL:-true}" =~ ^(1|true|yes)$ ]]; then
      echo "[vps-start] WARN: Hermes dashboard failed to start; continuing" >&2
    else
      echo "[vps-start] Hermes dashboard failed to start" >&2
      exit 1
    fi
  fi
fi

# Last write wins: legacy dist/hermesApi.js may have run on health probes without mcp-gbrain.
ensure_hermes_gbrain_mcp_config
reload_hermes_gateway_after_config_change
start_hermes_gbrain_config_watchdog
start_gbrain_mcp_watchdog
start_gbrain_empty_index_watchdog
start_connectors_mcp_watchdog
start_composio_mcp_guard_watchdog
wait_for_hermes_gateway || true
verify_hermes_skills_denylist

wait "${JOSHU_PID}"
