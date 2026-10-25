#!/usr/bin/env bash
# Start gbrain indexing (sync --watch) for ArozOS Desktop trees. Hermes connects via MCP (gbrain serve).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/joshu}"
SCRIPTS_DIR="${JOSHU_SCRIPTS_ROOT:-${APP_DIR}/scripts}"
AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
export PATH="${HOME}/.bun/bin:/usr/local/bin:${PATH}"
# shellcheck source=lib/gbrain-env.sh
source "${SCRIPTS_DIR}/lib/gbrain-env.sh"
gbrain_env_init "${BASH_SOURCE[0]}"
# shellcheck source=lib/joshu-files-paths.sh
source "${SCRIPTS_DIR}/lib/joshu-files-paths.sh"
# shellcheck source=lib/pid-file.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pid-file.sh"
GBRAIN_HOME="${GBRAIN_HOME:-${HOME}/.gbrain}"
GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
# Joshu gbrain fixes (idempotent; also baked into the image).
node "${SCRIPTS_DIR}/patch-gbrain.mjs" || true
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

stop_sync_watch_if_running() {
  stop_pid_file_process "${GBRAIN_PID_FILE}" "sync --watch" "[gbrain]"
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

bash "${SCRIPTS_DIR}/stop-gbrain.sh"

bash "${SCRIPTS_DIR}/bootstrap-joshu-files.sh"
gbrain_repair_pglite_config_if_needed

joshu_files_resolve_paths "${APP_DIR}"
if [[ -n "${JOSHU_DESKTOP_ROOT:-}" ]]; then
  echo "[gbrain] ArozOS desktop: ${JOSHU_DESKTOP_ROOT}"
  echo "[gbrain] Joshu files root: ${JOSHU_FILES_ROOT}"
  # shellcheck source=lib/ensure-gbrain-git.sh
  source "${SCRIPTS_DIR}/lib/ensure-gbrain-git.sh"
  ensure_gbrain_git_repo "${JOSHU_DESKTOP_ROOT}"
  # One source (`default`) for the whole Desktop, matching the MCP bridge's
  # sync_brain(repo=Desktop). Slugs are Desktop-relative (joshus-files/journals/…),
  # so sync.repo_path must be the Desktop for slug -> file resolution.
  run_gbrain config set sync.repo_path "${JOSHU_DESKTOP_ROOT}" 2>/dev/null || true
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

# Pre-June-2026 boot registered a federated `j-<user>` source per Desktop and
# synced into it, while the MCP bridge writes the same files into `default`.
# Pages left in `j-*` break updates (createVersion "page not found" + re-embed
# loop). Drop empty ones; leave non-empty ones for a manual repair.
remove_legacy_desktop_sources() {
  local id pages
  while read -r id pages; do
    [[ -n "${id}" ]] || continue
    if [[ "${pages}" == "0" ]]; then
      echo "[gbrain] removing empty legacy source ${id}"
      run_gbrain sources remove "${id}" --yes >/dev/null 2>&1 || true
    else
      echo "[gbrain] WARN: legacy source ${id} still holds ${pages} pages (duplicates of default); repair needed" >&2
    fi
  done < <(run_gbrain sources list 2>/dev/null | awk '$1 ~ /^j-/ { for (i = 2; i <= NF; i++) if ($i == "pages") print $1, $(i - 1) }')
  rm -f "${GBRAIN_HOME}/registered-sources.env"
}

remove_legacy_desktop_sources

quick_boot=false
if [[ "${GBRAIN_BOOT_QUICK:-}" =~ ^(1|true|yes)$ ]]; then
  quick_boot=true
  echo "[gbrain] quick boot (skip sync/embed); full index runs in background"
fi

if [[ "${quick_boot}" != "true" ]]; then
  if [[ -n "${JOSHU_DESKTOP_ROOT:-}" ]]; then
    echo "[gbrain] staging Desktop git tree before initial sync"
    node "${SCRIPTS_DIR}/lib/run-stage-desktop-git.mjs" "${JOSHU_DESKTOP_ROOT}" 2>>"${GBRAIN_LOG_FILE}" || true
  fi

  sync_root="${JOSHU_DESKTOP_ROOT:-${JOSHU_FILES_ROOT:-}}"
  echo "[gbrain] initial sync + embed (${sync_root:-sync.repo_path} -> default source)"
  # --skip-failed: do not block boot when a previously recorded bad file (e.g. HERMES.md)
  # is still in the failure ledger. Excludes are enforced via Desktop/.gitignore.
  run_gbrain sync ${sync_root:+--repo "${sync_root}"} --no-pull --yes --skip-failed 2>>"${GBRAIN_LOG_FILE}" || true
  run_gbrain embed --stale 2>>"${GBRAIN_LOG_FILE}" || true
fi

# Soft-delete pages whose file is gone (full syncs never delete). Needs the
# PGLite lock, so it runs here before gbrain serve starts.
if [[ -n "${JOSHU_DESKTOP_ROOT:-}" ]]; then
  ( unset DATABASE_URL GBRAIN_DATABASE_URL; export_gbrain_embedding_env
    bun "${SCRIPTS_DIR}/gbrain-prune-orphans.ts" "${JOSHU_DESKTOP_ROOT}" --apply ) || true
fi

if [[ "${GBRAIN_SYNC_WATCH}" == "true" ]]; then
  if [[ -f "${GBRAIN_PID_FILE}" ]]; then
    old_pid="$(cat "${GBRAIN_PID_FILE}" 2>/dev/null || true)"
    if pid_runs_command "${old_pid}" "sync --watch"; then
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

bash "${SCRIPTS_DIR}/setup-gbrain-schema.sh" || true

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
