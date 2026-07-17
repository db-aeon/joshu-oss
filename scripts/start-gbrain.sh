#!/usr/bin/env bash
# Start gbrain indexing (sync --watch) for ArozOS Desktop trees. Hermes connects via MCP (gbrain serve).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/joshu}"
AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
export PATH="${HOME}/.bun/bin:/usr/local/bin:${PATH}"
# shellcheck source=lib/gbrain-env.sh
source "${APP_DIR}/scripts/lib/gbrain-env.sh"
gbrain_env_init "${BASH_SOURCE[0]}"
# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
GBRAIN_HOME="${GBRAIN_HOME:-${HOME}/.gbrain}"
GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
GBRAIN_LOG_FILE="${GBRAIN_LOG_FILE:-${GBRAIN_HOME}/gbrain-sync.log}"
GBRAIN_PID_FILE="${GBRAIN_PID_FILE:-${GBRAIN_HOME}/gbrain-sync.pid}"
GBRAIN_EMBED_INTERVAL_SEC="${GBRAIN_EMBED_INTERVAL_SEC:-900}"
# PGLite allows one DB holder. Hermes MCP runs `gbrain serve`; do not also run sync --watch.
GBRAIN_SYNC_WATCH="${GBRAIN_SYNC_WATCH:-false}"
GBRAIN_CONFIG="${GBRAIN_HOME}/.gbrain/config.json"
GBRAIN_DB="${GBRAIN_HOME}/.gbrain/brain.pglite"

# gbrain's `schema use` and `loadConfig()` treat DATABASE_URL as Postgres and can
# overwrite a PGLite config.json on disk. Unset before every gbrain invocation.
export_gbrain_embedding_env() {
  export GOOGLE_API_KEY="${GOOGLE_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-}}"
  export GOOGLE_GENERATIVE_AI_API_KEY="${GOOGLE_GENERATIVE_AI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}}"
  export OPENAI_API_KEY="${OPENAI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}}"
}

run_gbrain() {
  (
    unset DATABASE_URL GBRAIN_DATABASE_URL
    export_gbrain_embedding_env
    "${GBRAIN_BIN}" "$@"
  )
}

slugify_source_id() {
  local raw="$1"
  printf '%s' "${raw}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/@/-at-/g' -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//'
}

stop_sync_watch_if_running() {
  if [[ ! -f "${GBRAIN_PID_FILE}" ]]; then
    return 0
  fi
  local old_pid
  old_pid="$(cat "${GBRAIN_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "[gbrain] stopping existing sync --watch (pid ${old_pid})"
    kill "${old_pid}" 2>/dev/null || true
  fi
  rm -f "${GBRAIN_PID_FILE}"
}

has_embedding=false
if [[ -n "${OPENAI_API_KEY:-}" || -n "${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}" ]]; then
  has_embedding=true
fi
if [[ -n "${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-}" || -n "${GOOGLE_API_KEY:-}" ]]; then
  has_embedding=true
fi
if [[ -n "${ZEROENTROPY_API_KEY:-}" ]]; then
  has_embedding=true
fi

if [[ "${has_embedding}" != "true" ]]; then
  echo "[gbrain] missing embedding API key (OPENAI, HINDSIGHT_API_EMBEDDINGS_*, or ZEROENTROPY_API_KEY)" >&2
  exit 1
fi

if ! command -v "${GBRAIN_BIN}" >/dev/null 2>&1; then
  echo "[gbrain] ${GBRAIN_BIN} not found. Run: bash scripts/install-gbrain.sh" >&2
  exit 1
fi

export GBRAIN_HOME
mkdir -p "${GBRAIN_HOME}" "$(dirname "${GBRAIN_LOG_FILE}")"

bash "${APP_DIR}/scripts/stop-gbrain.sh"

bash "${APP_DIR}/scripts/bootstrap-joshu-files.sh"
gbrain_repair_pglite_config_if_needed

joshu_files_resolve_paths "${APP_DIR}"
if [[ -n "${JOSHU_DESKTOP_ROOT:-}" ]]; then
  echo "[gbrain] ArozOS desktop: ${JOSHU_DESKTOP_ROOT}"
  echo "[gbrain] Joshu files root: ${JOSHU_FILES_ROOT}"
  # shellcheck source=lib/ensure-gbrain-git.sh
  source "${APP_DIR}/scripts/lib/ensure-gbrain-git.sh"
  ensure_gbrain_git_repo "${JOSHU_DESKTOP_ROOT}"
  # sync.repo_path + slug map to files under joshu's files (filesystem source of record).
  # slugs like journals/2026-05-24-todo land here, not Desktop/journals/.
  run_gbrain config set sync.repo_path "${JOSHU_FILES_ROOT}" 2>/dev/null || true
  mkdir -p "${GBRAIN_HOME}"
  {
    echo "JOSHU_FILES_ROOT=${JOSHU_FILES_ROOT}"
    echo "JOSHU_DESKTOP_ROOT=${JOSHU_DESKTOP_ROOT}"
    echo "JOSHU_AROZ_USER=${JOSHU_AROZ_USER}"
    echo "GBRAIN_SOURCE=${GBRAIN_SOURCE}"
    echo "AROZ_DATA=${JOSHU_AROZ_DATA}"
  } >"${GBRAIN_HOME}/joshu-files-paths.env"
fi

embedding_provider="${HINDSIGHT_API_EMBEDDINGS_PROVIDER:-}"
embedding_model_args=()
case "${embedding_provider}" in
  openai)
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}}"
    embedding_model_args=(
      --embedding-model "openai:${HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL:-text-embedding-3-small}"
      --embedding-dimensions 1536
    )
    ;;
  google)
    export GOOGLE_API_KEY="${GOOGLE_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-}}"
    export GOOGLE_GENERATIVE_AI_API_KEY="${GOOGLE_GENERATIVE_AI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}}"
    embedding_model_args=(
      --embedding-model "google:gemini-embedding-001"
      --embedding-dimensions 768
    )
    ;;
  *)
    if [[ -n "${ZEROENTROPY_API_KEY:-}" ]]; then
      embedding_model_args=(--embedding-model "zeroentropy:zembed-1" --embedding-dimensions 1280)
    elif [[ -n "${OPENAI_API_KEY:-}" || -n "${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}" ]]; then
      export OPENAI_API_KEY="${OPENAI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}}"
      embedding_model_args=(--embedding-model "openai:text-embedding-3-small" --embedding-dimensions 1536)
    fi
    ;;
esac

if [[ ! -f "${GBRAIN_CONFIG}" && ! -d "${GBRAIN_DB}" ]]; then
  echo "[gbrain] initializing PGLite brain at ${GBRAIN_HOME}"
  if (( ${#embedding_model_args[@]} > 0 )); then
  # --json skips the 60s interactive search-mode prompt on TTY installs.
    run_gbrain init --pglite --json "${embedding_model_args[@]}" >/dev/null
    run_gbrain config set search.mode "${GBRAIN_SEARCH_MODE:-balanced}" 2>/dev/null || true
  else
    echo "[gbrain] no embedding model args resolved; set HINDSIGHT_API_EMBEDDINGS_PROVIDER" >&2
    exit 1
  fi
fi

run_gbrain config set search.mode "${GBRAIN_SEARCH_MODE:-balanced}" 2>/dev/null || true

register_desktop_sources() {
  local desktop user_id user_slug source_id marker="${GBRAIN_HOME}/registered-sources.env"
  local needs_registration=false

  shopt -s nullglob
  for desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    [[ -d "${desktop}" ]] || continue
    user_id="$(basename "$(dirname "${desktop}")")"
    user_slug="$(slugify_source_id "${user_id}")"
    source_id="j-${user_slug}"
    if (( ${#source_id} > 32 )); then
      source_id="${source_id:0:32}"
      source_id="${source_id%-}"
    fi
    if run_gbrain sources list 2>/dev/null | grep -q "${source_id}"; then
      continue
    fi
    needs_registration=true
    echo "[gbrain] registering source ${source_id} -> ${desktop}"
    run_gbrain sources add "${source_id}" --path "${desktop}" --federated
  done

  if [[ "${needs_registration}" == "true" ]]; then
    printf 'REGISTERED_AROZ_DATA=%q\n' "${AROZ_DATA}" >"${marker}"
  elif [[ -f "${marker}" ]]; then
    # shellcheck disable=SC1090
    source "${marker}"
    if [[ "${REGISTERED_AROZ_DATA:-}" == "${AROZ_DATA}" ]]; then
      echo "[gbrain] sources already registered for ${AROZ_DATA}"
    fi
  fi
}

register_desktop_sources

quick_boot=false
if [[ "${GBRAIN_BOOT_QUICK:-}" =~ ^(1|true|yes)$ ]]; then
  quick_boot=true
  echo "[gbrain] quick boot (skip sync/embed); full index runs in background"
fi

if [[ "${quick_boot}" != "true" ]]; then
  if [[ -n "${JOSHU_DESKTOP_ROOT:-}" ]]; then
    echo "[gbrain] staging Desktop git tree before initial sync"
    node "${APP_DIR}/scripts/lib/run-stage-desktop-git.mjs" "${JOSHU_DESKTOP_ROOT}" 2>>"${GBRAIN_LOG_FILE}" || true
  fi

  echo "[gbrain] initial sync + embed (all registered sources)"
  # --skip-failed: do not block boot when a previously recorded bad file (e.g. HERMES.md)
  # is still in the failure ledger. Excludes are enforced via Desktop/.gitignore.
  run_gbrain sync --apply --no-pull --all --yes --skip-failed 2>>"${GBRAIN_LOG_FILE}" || true
  run_gbrain embed --stale 2>>"${GBRAIN_LOG_FILE}" || true
fi

if [[ "${GBRAIN_SYNC_WATCH}" == "true" ]]; then
  if [[ -f "${GBRAIN_PID_FILE}" ]]; then
    old_pid="$(cat "${GBRAIN_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      if run_gbrain doctor --fast >/dev/null 2>&1; then
        echo "[gbrain] sync --watch already running (pid ${old_pid})"
        exit 0
      fi
      stop_sync_watch_if_running
    fi
  fi

  echo "[gbrain] starting sync --watch (log: ${GBRAIN_LOG_FILE})"
  nohup bash -c '
    unset DATABASE_URL GBRAIN_DATABASE_URL
    export GBRAIN_HOME="'"${GBRAIN_HOME}"'"
    exec "'"${GBRAIN_BIN}"'" sync --watch
  ' >>"${GBRAIN_LOG_FILE}" 2>&1 &
  sync_pid=$!
  printf '%s\n' "${sync_pid}" >"${GBRAIN_PID_FILE}"

  (
    while kill -0 "${sync_pid}" 2>/dev/null; do
      sleep "${GBRAIN_EMBED_INTERVAL_SEC}"
      run_gbrain embed --stale >>"${GBRAIN_LOG_FILE}" 2>&1 || true
    done
  ) &
else
  echo "[gbrain] sync --watch disabled (PGLite single-holder; Joshu MCP HTTP runs gbrain serve)"
  echo "[gbrain] embed loop disabled (sync_brain via gbrain MCP HTTP server handles indexing)"
  rm -f "${GBRAIN_HOME}/gbrain-embed.pid"
fi

bash "${APP_DIR}/scripts/setup-gbrain-schema.sh" || true

if [[ "${quick_boot}" == "true" ]]; then
  echo "[gbrain] quick boot complete"
  exit 0
fi

if run_gbrain doctor --fast >/dev/null 2>&1; then
  echo "[gbrain] doctor OK; gbrain MCP HTTP: scripts/start-gbrain-mcp-http.sh"
  exit 0
fi

echo "[gbrain] doctor --fast reported issues; see ${GBRAIN_LOG_FILE}" >&2
exit 1
