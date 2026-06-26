#!/usr/bin/env bash
# One-shot embed for gbrain. Stops stale gbrain serve first so PGLite lock is free.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${0}")/.." && pwd)"
LOCAL_DIR="${ROOT_DIR}/.local"
GBRAIN_HOME="${GBRAIN_HOME:-${LOCAL_DIR}/gbrain}"
GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"

# shellcheck source=lib/joshu-files-paths.sh
source "${ROOT_DIR}/scripts/lib/joshu-files-paths.sh"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

export GBRAIN_HOME
export GOOGLE_API_KEY="${GOOGLE_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-}}"
export GOOGLE_GENERATIVE_AI_API_KEY="${GOOGLE_GENERATIVE_AI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}}"

bash "${ROOT_DIR}/scripts/stop-gbrain.sh"

run_gbrain() {
  (
    unset DATABASE_URL GBRAIN_DATABASE_URL
    "${GBRAIN_BIN}" "$@"
  )
}

echo "[gbrain] embedding stale pages at ${GBRAIN_HOME}"
run_gbrain embed --stale
run_gbrain doctor --fast | grep -E 'embed|Brain score' || true
echo "[gbrain] embed complete — restart dev:arozos so Hermes can reconnect gbrain serve"
