#!/usr/bin/env bash
# Seed EA v2 layout under JOSHU_FILES_ROOT (FILING.md, Triage/, Projects/) — idempotent.
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
TEMPLATE_DIR="${APP_DIR}/templates/ea"
EA_LAYOUT_VERSION="${EA_LAYOUT_VERSION:-2.0.0}"

seed_file_if_missing() {
  local dest="$1"
  local src="$2"
  if [[ ! -f "${dest}" && -f "${src}" ]]; then
    mkdir -p "$(dirname "${dest}")"
    cp "${src}" "${dest}"
    echo "[bootstrap-executive-assistant] seeded ${dest}"
  fi
}

seed_tree_if_missing() {
  local files_root="$1"
  mkdir -p \
    "${files_root}/Planning" \
    "${files_root}/Triage/_snapshots" \
    "${files_root}/Triage/_done" \
    "${files_root}/Projects/_system" \
    "${files_root}/Projects/other" \
    "${files_root}/Projects/other/scheduling" \
    "${files_root}/Projects/_archive" \
    "${files_root}/Projects/_template"

  seed_file_if_missing "${files_root}/FILING.md" "${TEMPLATE_DIR}/FILING.md"
  seed_file_if_missing "${files_root}/Projects/_system/summary-email.md" "${TEMPLATE_DIR}/Projects/_system/summary-email.md"
  seed_file_if_missing "${files_root}/Projects/other/about.md" "${TEMPLATE_DIR}/Projects/other/about.md"
  seed_file_if_missing "${files_root}/Projects/other/todo.md" "${TEMPLATE_DIR}/Projects/other/todo.md"
  seed_file_if_missing "${files_root}/Projects/_template/about.md" "${TEMPLATE_DIR}/Projects/_template/about.md"
  seed_file_if_missing "${files_root}/Projects/_template/todo.md" "${TEMPLATE_DIR}/Projects/_template/todo.md"
  seed_file_if_missing "${files_root}/Planning/capture-template.md" "${TEMPLATE_DIR}/Planning/capture-template.md"
  seed_file_if_missing "${files_root}/Planning/daily-review-template.md" "${TEMPLATE_DIR}/Planning/daily-review-template.md"

  if [[ ! -f "${files_root}/.joshu-ea-version" ]]; then
    printf 'ea-layout: %s\n' "${EA_LAYOUT_VERSION}" >"${files_root}/.joshu-ea-version"
    echo "[bootstrap-executive-assistant] wrote ${files_root}/.joshu-ea-version"
  fi
}

bootstrap_user_desktop() {
  local desktop="$1"
  local files_root="${desktop}/${JOSHU_FILES_DIR_NAME}"
  mkdir -p "${files_root}"
  seed_tree_if_missing "${files_root}"
  echo "[bootstrap-executive-assistant] ready ${files_root} (ea-layout ${EA_LAYOUT_VERSION})"
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
    echo "[bootstrap-executive-assistant] WARN: no ArozOS users; skipping" >&2
    return 1
  fi

  mkdir -p "${AROZ_DATA}/files/users/admin/Desktop"
  desktops=("${AROZ_DATA}/files/users/admin/Desktop")
}

if [[ ! -d "${TEMPLATE_DIR}" ]]; then
  echo "[bootstrap-executive-assistant] template dir missing: ${TEMPLATE_DIR}" >&2
  exit 1
fi

collect_desktops || exit 0

for desktop in "${desktops[@]}"; do
  [[ -d "${desktop}" ]] || continue
  bootstrap_user_desktop "${desktop}"
done
