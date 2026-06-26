#!/usr/bin/env bash
# Modal container entry: Camofox + Joshu (loopback) + ArozOS on the public port.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/joshu}"
CAMOFOX_APP_DIR="${CAMOFOX_APP_DIR:-/app}"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
HINDSIGHT_HOME="${HINDSIGHT_HOME:-/home/hindsight/.hindsight}"
HINDSIGHT_PROCESS_HOME="${HINDSIGHT_PROCESS_HOME:-/home/hindsight}"
HINDSIGHT_RUN_AS_USER="${HINDSIGHT_RUN_AS_USER:-hindsight}"
HINDSIGHT_LOCAL_DATABASE_URL="${HINDSIGHT_LOCAL_DATABASE_URL:-postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight}"
HINDSIGHT_POSTGRES_BIN_DIR="${HINDSIGHT_POSTGRES_BIN_DIR:-/usr/lib/postgresql/15/bin}"
HINDSIGHT_POSTGRES_DATA_DIR="${HINDSIGHT_POSTGRES_DATA_DIR:-/tmp/hindsight-postgres/data}"
HINDSIGHT_POSTGRES_LOG_FILE="${HINDSIGHT_POSTGRES_LOG_FILE:-/tmp/hindsight-postgres/postgres.log}"
export HINDSIGHT_HOME
export HINDSIGHT_PROCESS_HOME
export HINDSIGHT_RUN_AS_USER

AROZ_TEMPLATE="${AROZ_TEMPLATE:-/opt/arozos-template}"
AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"

# Joshu listens only on loopback; ArozOS reverse-proxies /joshu/* via the subservice.
JOSHU_PORT="${JOSHU_PORT:-8788}"
JOSHU_HEALTH_URL="${JOSHU_HEALTH_URL:-http://127.0.0.1:${JOSHU_PORT}/joshu/api/status}"
PUBLIC_AROZ_PORT="${PUBLIC_AROZ_PORT:-8787}"

load_env_file() {
  local env_file="$1"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

write_secret_file_from_b64() {
  local b64_value="$1"
  local target_path="$2"

  if [[ -n "${b64_value}" ]]; then
    mkdir -p "$(dirname "${target_path}")"
    printf '%s' "${b64_value}" | base64 -d > "${target_path}"
    chmod 600 "${target_path}"
    if id "${HINDSIGHT_RUN_AS_USER}" >/dev/null 2>&1; then
      chown "${HINDSIGHT_RUN_AS_USER}:${HINDSIGHT_RUN_AS_USER}" "${target_path}"
    fi
  fi
}

prepare_hindsight_runtime_user() {
  if id "${HINDSIGHT_RUN_AS_USER}" >/dev/null 2>&1; then
    mkdir -p \
      "${HINDSIGHT_HOME}" \
      "${HINDSIGHT_PROCESS_HOME}/.cache/huggingface"
    chown "${HINDSIGHT_RUN_AS_USER}:${HINDSIGHT_RUN_AS_USER}" \
      "${HINDSIGHT_PROCESS_HOME}" \
      "${HINDSIGHT_PROCESS_HOME}/.cache" \
      "${HINDSIGHT_PROCESS_HOME}/.cache/huggingface"
  fi
}

mkdir -p "${HERMES_HOME}"

# Optional secret material. These let Modal reuse local Hermes auth/config
# without baking credentials into the image.
if [[ -n "${HERMES_AUTH_JSON_B64:-}" ]]; then
  printf '%s' "${HERMES_AUTH_JSON_B64}" | base64 -d > "${HERMES_HOME}/auth.json"
  chmod 600 "${HERMES_HOME}/auth.json"
fi

if [[ -n "${HERMES_ENV_B64:-}" ]]; then
  printf '%s' "${HERMES_ENV_B64}" | base64 -d > "${HERMES_HOME}/.env"
  chmod 600 "${HERMES_HOME}/.env"
fi

if [[ -n "${HERMES_CONFIG_YAML_B64:-}" ]]; then
  printf '%s' "${HERMES_CONFIG_YAML_B64}" | base64 -d > "${HERMES_HOME}/config.yaml"
  chmod 600 "${HERMES_HOME}/config.yaml"
elif [[ ! -f "${HERMES_HOME}/config.yaml" ]]; then
  cat > "${HERMES_HOME}/config.yaml" <<'YAML'
browser:
  camofox:
    managed_persistence: true
memory:
  memory_enabled: false
YAML
fi

load_env_file "${HERMES_HOME}/.env"

prepare_hindsight_runtime_user

HINDSIGHT_SECRETS_DIR="${HINDSIGHT_SECRETS_DIR:-${HINDSIGHT_HOME}/secrets}"
if [[ -n "${HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_JSON_B64:-}" ]]; then
  HINDSIGHT_RERANKER_GOOGLE_SERVICE_ACCOUNT_PATH="${HINDSIGHT_SECRETS_DIR}/google-reranker-service-account.json"
  write_secret_file_from_b64 \
    "${HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_JSON_B64}" \
    "${HINDSIGHT_RERANKER_GOOGLE_SERVICE_ACCOUNT_PATH}"
  export HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY="${HINDSIGHT_RERANKER_GOOGLE_SERVICE_ACCOUNT_PATH}"
fi

if [[ -n "${HINDSIGHT_API_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_JSON_B64:-}" ]]; then
  HINDSIGHT_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_PATH="${HINDSIGHT_SECRETS_DIR}/vertexai-embeddings-service-account.json"
  write_secret_file_from_b64 \
    "${HINDSIGHT_API_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_JSON_B64}" \
    "${HINDSIGHT_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_PATH}"
  export HINDSIGHT_API_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_KEY="${HINDSIGHT_EMBEDDINGS_VERTEXAI_SERVICE_ACCOUNT_PATH}"
fi

prepare_hindsight_runtime_user

export HOST="${HOST:-127.0.0.1}"
export PORT="${JOSHU_PORT}"
export PUBLIC_BASE_PATH="${PUBLIC_BASE_PATH:-/joshu}"
export CAMOFOX_PORT="${CAMOFOX_PORT:-9377}"
export CAMOFOX_URL="${CAMOFOX_URL:-http://127.0.0.1:9377}"
export ENABLE_VNC="${ENABLE_VNC:-1}"
export NOVNC_PORT="${NOVNC_PORT:-6080}"
# Browser-visible noVNC path must match PUBLIC_BASE_PATH (proxied by ArozOS to Joshu).
# NOVNC_* paths are logical (/novnc); Express joins PUBLIC_BASE_PATH in server.ts (avoid /joshu/joshu/...).
export NOVNC_URL="${NOVNC_URL:-/novnc}"
export NOVNC_PROXY_TARGET="${NOVNC_PROXY_TARGET:-http://127.0.0.1:6080}"
export NOVNC_CLIENT_PATH="${NOVNC_CLIENT_PATH:-/novnc}"
export HERMES_BIN="${HERMES_BIN:-${HERMES_DIR}/venv/bin/hermes}"
export HERMES_API_BASE_URL="${HERMES_API_BASE_URL:-http://127.0.0.1:8642}"
export HERMES_API_KEY="${HERMES_API_KEY:-change-me-modal-dev}"
export HERMES_API_AUTO_START="${HERMES_API_AUTO_START:-true}"
export JOSHU_HERMES_SKILLS_DIR="${JOSHU_HERMES_SKILLS_DIR:-${APP_DIR}/integrations/hermes/skills}"
export HERMES_ENABLE_PROJECT_PLUGINS="${HERMES_ENABLE_PROJECT_PLUGINS:-true}"
export HITL_CAMOFOX_USER_ID="${HITL_CAMOFOX_USER_ID:-hitl-camofox}"
export HITL_CAMOFOX_SESSION_KEY="${HITL_CAMOFOX_SESSION_KEY:-hitl-main}"
export HITL_CAMOFOX_SINGLE_TAB="${HITL_CAMOFOX_SINGLE_TAB:-true}"
export CAMOFOX_USER_ID="${CAMOFOX_USER_ID:-${HITL_CAMOFOX_USER_ID}}"
export CAMOFOX_SESSION_KEY="${CAMOFOX_SESSION_KEY:-${HITL_CAMOFOX_SESSION_KEY}}"
export CAMOFOX_ADOPT_EXISTING_TAB="${CAMOFOX_ADOPT_EXISTING_TAB:-true}"
export CAMOFOX_AUTO_RESTART="${CAMOFOX_AUTO_RESTART:-false}"

export BROWSER_IDLE_TIMEOUT_MS="${BROWSER_IDLE_TIMEOUT_MS:-0}"
export SESSION_TIMEOUT_MS="${SESSION_TIMEOUT_MS:-1800000}"
export VNC_RESOLUTION="${VNC_RESOLUTION:-1024x768}"
export CAMOFOX_VIEWPORT_WIDTH="${CAMOFOX_VIEWPORT_WIDTH:-1024}"
export CAMOFOX_VIEWPORT_HEIGHT="${CAMOFOX_VIEWPORT_HEIGHT:-768}"
export CAMOFOX_START_URL="${CAMOFOX_START_URL:-https://news.google.com/}"
export MAX_TABS_PER_SESSION="${MAX_TABS_PER_SESSION:-1}"
export MAX_TABS_GLOBAL="${MAX_TABS_GLOBAL:-1}"
export CAMOFOX_MAX_TABS="${CAMOFOX_MAX_TABS:-1}"
export HITL_FORCE_SINGLE_VISIBLE_PAGE="${HITL_FORCE_SINGLE_VISIBLE_PAGE:-true}"
export MAX_OLD_SPACE_SIZE="${MAX_OLD_SPACE_SIZE:-256}"
export HINDSIGHT_API_HOST="${HINDSIGHT_API_HOST:-127.0.0.1}"
export HINDSIGHT_API_PORT="${HINDSIGHT_API_PORT:-8888}"
export HINDSIGHT_API_URL="${HINDSIGHT_API_URL:-http://${HINDSIGHT_API_HOST}:${HINDSIGHT_API_PORT}}"
export HINDSIGHT_API_BIN="${HINDSIGHT_API_BIN:-${HERMES_DIR}/venv/bin/hindsight-api}"
export HINDSIGHT_LOG_FILE="${HINDSIGHT_LOG_FILE:-${HINDSIGHT_HOME}/hindsight-api.log}"
export HINDSIGHT_API_WORKER_ID="${HINDSIGHT_API_WORKER_ID:-joshu-hitl-hindsight}"
export HINDSIGHT_REQUIRE_EXTERNAL_ML="${HINDSIGHT_REQUIRE_EXTERNAL_ML:-true}"
export HINDSIGHT_API_DATABASE_BACKEND="${HINDSIGHT_API_DATABASE_BACKEND:-postgresql}"
export HINDSIGHT_API_DATABASE_URL="${HINDSIGHT_API_DATABASE_URL:-${HINDSIGHT_LOCAL_DATABASE_URL}}"
export HINDSIGHT_API_MIGRATION_DATABASE_URL="${HINDSIGHT_API_MIGRATION_DATABASE_URL:-${HINDSIGHT_API_DATABASE_URL}}"
# shellcheck source=lib/arozos-desktop-shortcuts.sh
source "${APP_DIR}/scripts/lib/arozos-desktop-shortcuts.sh"

start_hindsight_if_needed() {
  if [[ "${JOSHU_HINDSIGHT_ENABLED:-false}" != "true" ]]; then
    echo "[modal-start] Hindsight disabled; skipping Hindsight API startup"
    return 0
  fi

  if bash "${APP_DIR}/scripts/start-hindsight.sh"; then
    return 0
  fi

  if [[ "${JOSHU_HINDSIGHT_OPTIONAL:-false}" =~ ^(1|true|yes|on)$ ]]; then
    echo "[modal-start] Hindsight failed to start; continuing with JOSHU_HINDSIGHT_ENABLED=false" >&2
    export JOSHU_HINDSIGHT_ENABLED=false
    return 0
  fi

  echo "[modal-start] Hindsight failed to start" >&2
  return 1
}

start_hindsight_postgres_if_needed() {
  if [[ "${JOSHU_HINDSIGHT_ENABLED:-false}" != "true" ]]; then
    return 0
  fi

  case "${HINDSIGHT_API_DATABASE_URL}" in
    "${HINDSIGHT_LOCAL_DATABASE_URL}"|"postgresql://hindsight:hindsight@localhost:5432/hindsight")
      ;;
    *)
      echo "[modal-start] using external Hindsight database: ${HINDSIGHT_API_DATABASE_URL%%@*}@..."
      return 0
      ;;
  esac

  if [[ ! -x "${HINDSIGHT_POSTGRES_BIN_DIR}/postgres" ]]; then
    echo "[modal-start] local PostgreSQL binary not found at ${HINDSIGHT_POSTGRES_BIN_DIR}/postgres" >&2
    return 1
  fi

  mkdir -p "$(dirname "${HINDSIGHT_POSTGRES_DATA_DIR}")" "$(dirname "${HINDSIGHT_POSTGRES_LOG_FILE}")"
  chown -R postgres:postgres "$(dirname "${HINDSIGHT_POSTGRES_DATA_DIR}")" "$(dirname "${HINDSIGHT_POSTGRES_LOG_FILE}")"

  if [[ ! -s "${HINDSIGHT_POSTGRES_DATA_DIR}/PG_VERSION" ]]; then
    echo "[modal-start] initializing local Hindsight PostgreSQL in ${HINDSIGHT_POSTGRES_DATA_DIR}"
    runuser -u postgres -- \
      "${HINDSIGHT_POSTGRES_BIN_DIR}/initdb" \
      -D "${HINDSIGHT_POSTGRES_DATA_DIR}" \
      --encoding=UTF8 \
      --locale=C.UTF-8
  fi

  if ! runuser -u postgres -- "${HINDSIGHT_POSTGRES_BIN_DIR}/pg_ctl" -D "${HINDSIGHT_POSTGRES_DATA_DIR}" status >/dev/null 2>&1; then
    echo "[modal-start] starting local Hindsight PostgreSQL on 127.0.0.1:5432"
    runuser -u postgres -- \
      "${HINDSIGHT_POSTGRES_BIN_DIR}/pg_ctl" \
      -D "${HINDSIGHT_POSTGRES_DATA_DIR}" \
      -l "${HINDSIGHT_POSTGRES_LOG_FILE}" \
      -o "-c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=/tmp" \
      -w start
  fi

  runuser -u postgres -- "${HINDSIGHT_POSTGRES_BIN_DIR}/psql" -h /tmp -v ON_ERROR_STOP=1 postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hindsight') THEN
    CREATE ROLE hindsight WITH LOGIN PASSWORD 'hindsight';
  ELSE
    ALTER ROLE hindsight WITH LOGIN PASSWORD 'hindsight';
  END IF;
END
$$;
SELECT 'CREATE DATABASE hindsight OWNER hindsight'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hindsight')\gexec
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL PRIVILEGES ON DATABASE hindsight TO hindsight;
SQL

  echo "[modal-start] local Hindsight PostgreSQL is ready"
}

echo "[modal-start] starting Camofox on ${CAMOFOX_URL} with noVNC on ${NOVNC_PROXY_TARGET}"
(
  cd "${CAMOFOX_APP_DIR}"
  node --max-old-space-size="${MAX_OLD_SPACE_SIZE}" server.js
) &
camofox_pid=$!

for _ in $(seq 1 90); do
  if curl -fsS "${CAMOFOX_URL}/health" >/dev/null 2>&1; then
    echo "[modal-start] Camofox is healthy"
    break
  fi
  if ! kill -0 "${camofox_pid}" >/dev/null 2>&1; then
    echo "[modal-start] Camofox exited early" >&2
    wait "${camofox_pid}"
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "${CAMOFOX_URL}/health" >/dev/null 2>&1; then
  echo "[modal-start] timed out waiting for Camofox" >&2
  exit 1
fi

start_hindsight_postgres_if_needed
start_hindsight_if_needed

echo "[modal-start] starting Joshu Express on ${HOST}:${PORT} (base ${PUBLIC_BASE_PATH})"
(
  cd "${APP_DIR}"
  exec node dist/server.js
) &
joshu_pid=$!

for _ in $(seq 1 60); do
  if curl -fsS "${JOSHU_HEALTH_URL}" >/dev/null 2>&1; then
    echo "[modal-start] Joshu is healthy (${JOSHU_HEALTH_URL})"
    break
  fi
  if ! kill -0 "${joshu_pid}" >/dev/null 2>&1; then
    echo "[modal-start] Joshu exited early" >&2
    wait "${joshu_pid}"
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "${JOSHU_HEALTH_URL}" >/dev/null 2>&1; then
  echo "[modal-start] timed out waiting for Joshu" >&2
  exit 1
fi

# --- ArozOS persistent tree (first boot copies template from image; then reuse volume)
echo "[modal-start] preparing ArozOS data in ${AROZ_DATA}"
mkdir -p "${AROZ_DATA}"

if [[ ! -f "${AROZ_DATA}/.joshu-bootstrapped" ]]; then
  echo "[modal-start] first boot: copying ArozOS template from ${AROZ_TEMPLATE}"
  rsync -a "${AROZ_TEMPLATE}/" "${AROZ_DATA}/"
  touch "${AROZ_DATA}/.joshu-bootstrapped"
fi

# Always refresh app subservice bundles from the image (proxy/script/static asset updates).
sync_joshu_aroz_subservices_from_template "${AROZ_TEMPLATE}"
install_all_joshu_desktop_shortcuts

cd "${AROZ_DATA}"

# ArozOS -tmp is the *parent* directory: it creates <tmp>/tmp/ for tmp:/ (see ArozOS README). Using
# ${AROZ_DATA}/tmp produced ${AROZ_DATA}/tmp/tmp/ and panicked "Mount point not exists!".
mkdir -p "${AROZ_DATA}/files"
echo "[modal-start] starting ArozOS on 0.0.0.0:${PUBLIC_AROZ_PORT} (Joshu subservice -> ${JOSHU_HEALTH_URL})"
# Do not `exec` here: this shell must stay parent of the Camofox and Joshu background jobs.
"${AROZ_TEMPLATE}/arozos" \
  -port="${PUBLIC_AROZ_PORT}" \
  -disable_ip_resolver=true \
  -hostname="${AROZ_HOSTNAME:-Joshu-HITL}" \
  -tmp="${AROZ_DATA}" \
  -root="${AROZ_DATA}/files"
