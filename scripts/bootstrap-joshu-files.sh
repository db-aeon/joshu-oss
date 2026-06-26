#!/usr/bin/env bash
# Create Desktop/joshu's files as an empty folder for every ArozOS user (no seeds).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/joshu}"
if [[ ! -d "${APP_DIR}/scripts" ]]; then
  APP_DIR="${ROOT_DIR}"
fi

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
if [[ "${AROZ_DATA}" == "/var/lib/arozos" && -d "${APP_DIR}/.local/arozos-data" ]]; then
  AROZ_DATA="${APP_DIR}/.local/arozos-data"
fi

DEFAULT_JOSHU_FILES_DIR="joshu's files"
JOSHU_FILES_DIR_NAME="${JOSHU_FILES_DIR_NAME:-${DEFAULT_JOSHU_FILES_DIR}}"

bootstrap_user_desktop() {
  local desktop="$1"
  local files_root="${desktop}/${JOSHU_FILES_DIR_NAME}"
  local kb_inbox="${files_root}/research/kb/inbox"
  local kb_drop="${kb_inbox}/DROP_PDFS_HERE.md"

  mkdir -p "${files_root}" "${kb_inbox}" "${files_root}/research/kb/.raw"
  if [[ ! -f "${kb_drop}" ]]; then
    cat >"${kb_drop}" <<'EOF'
# Knowledge base — PDF drop folder

Drop `.pdf` files here. Joshu extracts text automatically and indexes them under `research/kb/` (searchable in File Brain within a few seconds).

Originals are archived in `research/kb/.raw/`.
EOF
  fi
  echo "[bootstrap-joshu-files] ready ${files_root}"
}

is_vps_aroz_data() {
  [[ "${AROZ_DATA}" == "/var/lib/arozos" ]]
}

collect_desktops() {
  desktops=()
  if [[ -n "${JOSHU_AROZ_USER:-}" ]]; then
    local owner_desktop="${AROZ_DATA}/files/users/${JOSHU_AROZ_USER}/Desktop"
    mkdir -p "${owner_desktop}"
    desktops=("${owner_desktop}")
    return 0
  fi

  shopt -s nullglob
  local found=("${AROZ_DATA}"/files/users/*/Desktop)
  if (( ${#found[@]} > 0 )); then
    desktops=("${found[@]}")
    return 0
  fi

  if is_vps_aroz_data; then
    echo "[bootstrap-joshu-files] WARN: no ArozOS users and JOSHU_AROZ_USER unset; skipping (set owner email at provision)" >&2
    return 1
  fi

  # Local dev fallback when no users exist yet
  mkdir -p "${AROZ_DATA}/files/users/admin/Desktop"
  desktops=("${AROZ_DATA}/files/users/admin/Desktop")
}

collect_desktops || exit 0

for desktop in "${desktops[@]}"; do
  [[ -d "${desktop}" ]] || continue
  bootstrap_user_desktop "${desktop}"
done

if [[ -x "${APP_DIR}/scripts/joshu-box-factory-apply.sh" ]]; then
  APP_DIR="${APP_DIR}" AROZ_DATA="${AROZ_DATA}" bash "${APP_DIR}/scripts/joshu-box-factory-apply.sh" || {
    if [[ -x "${APP_DIR}/scripts/bootstrap-executive-assistant.sh" ]]; then
      APP_DIR="${APP_DIR}" AROZ_DATA="${AROZ_DATA}" bash "${APP_DIR}/scripts/bootstrap-executive-assistant.sh" || true
    fi
  }
elif [[ -x "${APP_DIR}/scripts/bootstrap-executive-assistant.sh" ]]; then
  APP_DIR="${APP_DIR}" AROZ_DATA="${AROZ_DATA}" bash "${APP_DIR}/scripts/bootstrap-executive-assistant.sh" || true
fi
