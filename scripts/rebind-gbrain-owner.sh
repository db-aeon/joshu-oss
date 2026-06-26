#!/usr/bin/env bash
# Re-point gbrain + Hermes MCP at JOSHU_AROZ_USER after provision or owner change.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/joshu}"
# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"

load_env_file() {
  local f="$1"
  [[ -f "${f}" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "${f}"
  set +a
}

load_env_file "/etc/joshu/instance.env"
load_env_file "${HERMES_HOME:-/root/.hermes}/.env"

if [[ -z "${JOSHU_AROZ_USER:-}" ]]; then
  echo "[rebind-gbrain-owner] JOSHU_AROZ_USER unset; nothing to do" >&2
  exit 0
fi

export AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
export PATH="${HOME}/.bun/bin:/usr/local/bin:${PATH}"
export GBRAIN_BIN="${GBRAIN_BIN:-$(command -v gbrain 2>/dev/null || echo "${HOME}/.bun/bin/gbrain")}"

echo "[rebind-gbrain-owner] owner=${JOSHU_AROZ_USER}"
bash "${APP_DIR}/scripts/bootstrap-joshu-files.sh"

if [[ -f "${APP_DIR}/scripts/ensure-hermes-gbrain-mcp.mjs" ]]; then
  node "${APP_DIR}/scripts/ensure-hermes-gbrain-mcp.mjs"
fi

# Full gbrain sync/embed can take minutes and blocks VPS boot; vps-start runs it after ArozOS is up.
if [[ -f "${APP_DIR}/scripts/start-gbrain.sh" ]] && [[ ! "${JOSHU_REBIND_SKIP_GBRAIN_START:-}" =~ ^(1|true|yes)$ ]]; then
  bash "${APP_DIR}/scripts/start-gbrain.sh"
fi

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
# shellcheck source=lib/hermes-gateway.sh
source "${APP_DIR}/scripts/lib/hermes-gateway.sh"
restart_hermes_gateway_if_running

joshu_files_resolve_paths
echo "[rebind-gbrain-owner] files_root=${JOSHU_FILES_ROOT:-<unset>}"
