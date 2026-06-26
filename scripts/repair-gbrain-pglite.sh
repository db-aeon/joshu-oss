#!/usr/bin/env bash
# Rebuild PGLite when gbrain hits WASM Aborted() on open (often WAL/checkpoint corruption).
# See https://github.com/garrytan/gbrain/issues/223
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=lib/gbrain-env.sh
source "${APP_DIR}/scripts/lib/gbrain-env.sh"
gbrain_env_init "${BASH_SOURCE[0]}"

GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
GBRAIN_DB="${GBRAIN_HOME}/.gbrain/brain.pglite"
GBRAIN_CONFIG="${GBRAIN_HOME}/.gbrain/config.json"
AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"

export PATH="${HOME}/.bun/bin:/usr/local/bin:${PATH}"

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

pglite_opens_cleanly() {
  local out
  out="$(run_gbrain sync --dry-run 2>&1)" && return 0
  if echo "${out}" | grep -q "PGLite failed to initialize"; then
    return 1
  fi
  # Other errors are not corruption; do not auto-rebuild.
  return 0
}

if pglite_opens_cleanly; then
  echo "[gbrain-repair] PGLite OK at ${GBRAIN_DB}"
  exit 0
fi

if [[ "${GBRAIN_REPAIR_PGLITE:-}" != "1" && "${GBRAIN_REPAIR_PGLITE:-}" != "true" ]]; then
  echo "[gbrain-repair] PGLite appears corrupt; set GBRAIN_REPAIR_PGLITE=1 to rebuild ${GBRAIN_DB}" >&2
  exit 1
fi

echo "[gbrain-repair] rebuilding PGLite at ${GBRAIN_HOME}"
bash "${APP_DIR}/scripts/stop-gbrain.sh"

backup_dir="${GBRAIN_HOME}/backups"
mkdir -p "${backup_dir}"
stamp="$(date -u +%Y%m%d-%H%M%S)"
if [[ -d "${GBRAIN_HOME}/.gbrain" ]]; then
  tar -czf "${backup_dir}/gbrain-home-${stamp}.tar.gz" -C "${GBRAIN_HOME}" .gbrain 2>/dev/null || true
fi
if [[ -d "${GBRAIN_DB}" ]]; then
  mv "${GBRAIN_DB}" "${GBRAIN_DB}.broken-${stamp}"
fi

gbrain_repair_pglite_config_if_needed

embedding_model_args=()
provider="${HINDSIGHT_API_EMBEDDINGS_PROVIDER:-}"
case "${provider}" in
  openai)
    embedding_model_args=(--embedding-model "openai:${HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL:-text-embedding-3-small}" --embedding-dimensions 1536)
    ;;
  google)
    embedding_model_args=(--embedding-model "google:gemini-embedding-001" --embedding-dimensions 768)
    ;;
  *)
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
      embedding_model_args=(--embedding-model "openai:text-embedding-3-small" --embedding-dimensions 1536)
    elif [[ -n "${GOOGLE_API_KEY:-}" ]]; then
      embedding_model_args=(--embedding-model "google:gemini-embedding-001" --embedding-dimensions 768)
    fi
    ;;
esac

if (( ${#embedding_model_args[@]} == 0 )); then
  echo "[gbrain-repair] no embedding API key; cannot init PGLite" >&2
  exit 1
fi

run_gbrain init --pglite --json "${embedding_model_args[@]}"
run_gbrain config set search.mode "${GBRAIN_SEARCH_MODE:-balanced}" 2>/dev/null || true

# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
joshu_files_resolve_paths "${APP_DIR}" 2>/dev/null || true

shopt -s nullglob
for desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
  [[ -d "${desktop}" ]] || continue
  user_id="$(basename "$(dirname "${desktop}")")"
  user_slug="$(printf '%s' "${user_id}" | tr '[:upper:]' '[:lower:]' | sed -e 's/@/-at-/g' -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g')"
  source_id="j-${user_slug}"
  if (( ${#source_id} > 32 )); then
    source_id="${source_id:0:32}"
    source_id="${source_id%-}"
  fi
  echo "[gbrain-repair] registering ${source_id} -> ${desktop}"
  run_gbrain sources add "${source_id}" --path "${desktop}" --federated 2>/dev/null || true
done

if [[ -n "${JOSHU_FILES_ROOT:-}" ]]; then
  run_gbrain config set sync.repo_path "${JOSHU_FILES_ROOT}" 2>/dev/null || true
fi

echo "[gbrain-repair] PGLite rebuilt; run start-gbrain.sh / start-gbrain-mcp-http.sh to re-index"
