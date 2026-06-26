#!/usr/bin/env bash
# Ensure gbrain PGLite index matches on-disk markdown (VPS quick-boot recovery).
# Soft path: git stage + MCP reindex touch. Hard path: full sync+embed (GBRAIN_BOOT_QUICK=false).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/joshu}"
# shellcheck source=lib/gbrain-env.sh
source "${APP_DIR}/scripts/lib/gbrain-env.sh"
gbrain_env_init "${BASH_SOURCE[0]}"

AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
joshu_files_resolve_paths "${APP_DIR}" 2>/dev/null || true
export JOSHU_FILES_ROOT JOSHU_DESKTOP_ROOT JOSHU_AROZ_USER GBRAIN_SOURCE AROZ_DATA

export_gbrain_embedding_env() {
  export GOOGLE_API_KEY="${GOOGLE_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-}}"
  export GOOGLE_GENERATIVE_AI_API_KEY="${GOOGLE_GENERATIVE_AI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}}"
  export OPENAI_API_KEY="${OPENAI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}}"
}
export_gbrain_embedding_env

GBRAIN_MCP_HTTP_URL="${GBRAIN_MCP_HTTP_URL:-http://127.0.0.1:8794}"
GBRAIN_LOG_FILE="${GBRAIN_LOG_FILE:-${GBRAIN_HOME}/gbrain-ensure-indexed.log}"
FULL_SYNC_COOLDOWN_SEC="${GBRAIN_FULL_SYNC_COOLDOWN_SEC:-1800}"
FULL_SYNC_STAMP="${GBRAIN_HOME}/.gbrain-full-sync.last"
SOFT_WAIT_SEC="${GBRAIN_ENSURE_SOFT_WAIT_SEC:-45}"

MODE="auto"
for arg in "$@"; do
  case "${arg}" in
    --soft) MODE="soft" ;;
    --full) MODE="full" ;;
    --check-only) MODE="check" ;;
  esac
done

log() {
  local line="[gbrain-ensure-indexed] $*"
  echo "${line}"
  mkdir -p "$(dirname "${GBRAIN_LOG_FILE}")"
  printf '%s\n' "${line}" >>"${GBRAIN_LOG_FILE}"
}

assess_index() {
  JOSHU_DESKTOP_ROOT="${JOSHU_DESKTOP_ROOT:-}" \
    GBRAIN_MCP_HTTP_URL="${GBRAIN_MCP_HTTP_URL}" \
    node "${APP_DIR}/scripts/lib/gbrain-index-health.mjs" --json "${JOSHU_DESKTOP_ROOT:-}"
}

full_sync_cooldown_active() {
  [[ -f "${FULL_SYNC_STAMP}" ]] || return 1
  local now last age
  now="$(date +%s)"
  last="$(cat "${FULL_SYNC_STAMP}" 2>/dev/null || echo 0)"
  age=$((now - last))
  (( age < FULL_SYNC_COOLDOWN_SEC ))
}

mark_full_sync() {
  mkdir -p "${GBRAIN_HOME}"
  date +%s >"${FULL_SYNC_STAMP}"
}

run_soft_reindex() {
  log "soft recovery: ensure git + MCP reindex touch"
  # shellcheck source=lib/ensure-gbrain-git.sh
  source "${APP_DIR}/scripts/lib/ensure-gbrain-git.sh"
  if [[ -n "${JOSHU_DESKTOP_ROOT:-}" ]]; then
    ensure_gbrain_git_repo "${JOSHU_DESKTOP_ROOT}"
    node "${APP_DIR}/scripts/lib/run-stage-desktop-git.mjs" "${JOSHU_DESKTOP_ROOT}" \
      >>"${GBRAIN_LOG_FILE}" 2>&1 || true
  fi
  if ! curl -fsS "${GBRAIN_MCP_HTTP_URL%/}/health" 2>/dev/null | grep -q '"session_ready":true'; then
    log "MCP HTTP not ready — starting"
    bash "${APP_DIR}/scripts/start-gbrain-mcp-http.sh" >>"${GBRAIN_LOG_FILE}" 2>&1 || true
  fi
  touch_file="${GBRAIN_HOME}/.joshu-reindex-touch"
  mkdir -p "${GBRAIN_HOME}"
  touch "${touch_file}" 2>/dev/null || true
}

run_full_sync() {
  log "full recovery: GBRAIN_BOOT_QUICK=false start-gbrain + MCP HTTP"
  mark_full_sync
  export GBRAIN_BOOT_QUICK=false
  bash "${APP_DIR}/scripts/stop-gbrain.sh" >>"${GBRAIN_LOG_FILE}" 2>&1 || true
  bash "${APP_DIR}/scripts/start-gbrain.sh" >>"${GBRAIN_LOG_FILE}" 2>&1
  bash "${APP_DIR}/scripts/start-gbrain-mcp-http.sh" >>"${GBRAIN_LOG_FILE}" 2>&1
}

report="$(assess_index || true)"
needs_recovery="$(node -e "const r=JSON.parse(process.argv[1]); process.stdout.write(r.needsRecovery?'yes':'no')" "${report}" 2>/dev/null || echo no)"
disk_md="$(node -e "const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.diskMarkdown??0))" "${report}" 2>/dev/null || echo 0)"
indexed="$(node -e "const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.indexedPages??0))" "${report}" 2>/dev/null || echo 0)"

log "check disk=${disk_md} indexed=${indexed} needs_recovery=${needs_recovery} mode=${MODE}"

if [[ "${MODE}" == "check" ]]; then
  [[ "${needs_recovery}" != "yes" ]]
  exit $?
fi

if [[ "${needs_recovery}" != "yes" ]]; then
  log "index OK or nothing to index"
  exit 0
fi

if [[ "${MODE}" == "full" ]]; then
  run_full_sync
  exit 0
fi

if [[ "${MODE}" == "soft" ]]; then
  run_soft_reindex
  exit 0
fi

# auto: soft first, then full if still empty (respect cooldown)
run_soft_reindex
log "waiting ${SOFT_WAIT_SEC}s for MCP reindex"
sleep "${SOFT_WAIT_SEC}"

report="$(assess_index || true)"
needs_recovery="$(node -e "const r=JSON.parse(process.argv[1]); process.stdout.write(r.needsRecovery?'yes':'no')" "${report}" 2>/dev/null || echo no)"
indexed="$(node -e "const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.indexedPages??0))" "${report}" 2>/dev/null || echo 0)"
log "after soft recovery indexed=${indexed} needs_recovery=${needs_recovery}"

if [[ "${needs_recovery}" != "yes" ]]; then
  log "soft recovery succeeded"
  exit 0
fi

if full_sync_cooldown_active; then
  log "still empty but full-sync cooldown active (${FULL_SYNC_COOLDOWN_SEC}s); skipping"
  exit 1
fi

run_full_sync
report="$(assess_index || true)"
needs_recovery="$(node -e "const r=JSON.parse(process.argv[1]); process.stdout.write(r.needsRecovery?'yes':'no')" "${report}" 2>/dev/null || echo yes)"
if [[ "${needs_recovery}" == "yes" ]]; then
  log "WARN: full recovery completed but index still empty — check ${GBRAIN_HOME}/gbrain-mcp-http.log"
  exit 1
fi
log "full recovery succeeded"
exit 0
