# Shared env for gbrain scripts (local dev + VPS). Source from stop/start helpers.
# Usage: source "${APP_DIR}/scripts/lib/gbrain-env.sh"; gbrain_env_init "${BASH_SOURCE[0]}"

gbrain_env_init() {
  local caller="${1:-${BASH_SOURCE[1]:-$0}}"
  local scripts_dir
  scripts_dir="$(cd "$(dirname "${caller}")" && pwd)"
  APP_DIR="${APP_DIR:-$(cd "${scripts_dir}/.." && pwd)}"

  if [[ -f "${APP_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${APP_DIR}/.env"
    set +a
  fi

  # Local dev default (.env.example); VPS sets GBRAIN_HOME=/root/.gbrain before calling scripts.
  GBRAIN_HOME="${GBRAIN_HOME:-${APP_DIR}/.local/gbrain}"
  mkdir -p "${GBRAIN_HOME}"
  GBRAIN_HOME="$(cd "${GBRAIN_HOME}" && pwd)"
  export GBRAIN_HOME APP_DIR JOSHU_APP_ROOT="${APP_DIR}"

  AROZ_DATA="${AROZ_DATA:-${APP_DIR}/.local/arozos-data}"
  export AROZ_DATA
}

gbrain_require_pglite_brain() {
  local cfg="${GBRAIN_HOME}/.gbrain/config.json"
  local db="${GBRAIN_HOME}/.gbrain/brain.pglite"
  if [[ -f "${cfg}" || -d "${db}" ]]; then
    return 0
  fi
  echo "[gbrain] no PGLite brain at ${GBRAIN_HOME}" >&2
  echo "[gbrain] run: export APP_DIR=\"${APP_DIR}\" && bash scripts/start-gbrain.sh" >&2
  return 1
}

# PGLite data on disk but config.json still points at Postgres (DATABASE_URL leak).
gbrain_repair_pglite_config_if_needed() {
  local cfg="${GBRAIN_HOME}/.gbrain/config.json"
  local db="${GBRAIN_HOME}/.gbrain/brain.pglite"
  if [[ ! -d "${db}" || ! -f "${cfg}" ]]; then
    return 0
  fi
  if ! grep -qE '"engine"[[:space:]]*:[[:space:]]*"postgres"' "${cfg}" \
    && ! grep -q '"database_url"' "${cfg}"; then
    return 0
  fi
  echo "[gbrain] repairing config: PGLite data exists but config.json points at Postgres"
  node - "${cfg}" "${db}" <<'NODE'
const fs = require('fs');
const [cfgPath, dbPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.engine = 'pglite';
cfg.database_path = dbPath;
delete cfg.database_url;
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
NODE
}

gbrain_run() {
  (
    unset DATABASE_URL GBRAIN_DATABASE_URL
    "${GBRAIN_BIN:-gbrain}" "$@"
  )
}
