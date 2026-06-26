#!/usr/bin/env bash
# Resolve ArozOS Desktop / joshu's files paths (bash). Source from bootstrap/start-gbrain.
# Sets: JOSHU_AROZ_DATA, JOSHU_DESKTOP_ROOT, JOSHU_FILES_ROOT, JOSHU_AROZ_USER, GBRAIN_SOURCE

joshu_files_resolve_paths() {
  local app_dir="${1:-}"
  JOSHU_AROZ_DATA="${AROZ_DATA:-/var/lib/arozos}"
  if [[ -n "${app_dir}" && "${JOSHU_AROZ_DATA}" == "/var/lib/arozos" && -d "${app_dir}/.local/arozos-data" ]]; then
    JOSHU_AROZ_DATA="${app_dir}/.local/arozos-data"
  fi
  if [[ -n "${app_dir}" && "${JOSHU_AROZ_DATA}" == ".local/arozos-data" ]]; then
    JOSHU_AROZ_DATA="${app_dir}/.local/arozos-data"
  fi

  local default_dir="joshu's files"
  JOSHU_FILES_DIR_NAME="${JOSHU_FILES_DIR_NAME:-${default_dir}}"
  GBRAIN_SOURCE="${GBRAIN_SOURCE:-default}"

  local override_user="${JOSHU_AROZ_USER:-}"
  JOSHU_DESKTOP_ROOT=""
  JOSHU_FILES_ROOT=""
  JOSHU_AROZ_USER=""

  shopt -s nullglob
  local desktop user_id
  if [[ -n "${override_user}" ]]; then
    desktop="${JOSHU_AROZ_DATA}/files/users/${override_user}/Desktop"
    if [[ -d "${desktop}" ]]; then
      JOSHU_AROZ_USER="${override_user}"
      JOSHU_DESKTOP_ROOT="${desktop}"
      JOSHU_FILES_ROOT="${desktop}/${JOSHU_FILES_DIR_NAME}"
    fi
    return 0
  fi

  local desktop user_id
  for desktop in "${JOSHU_AROZ_DATA}"/files/users/*/Desktop; do
    [[ -d "${desktop}" ]] || continue
    user_id="$(basename "$(dirname "${desktop}")")"
    [[ "${user_id}" == "admin" ]] && continue
    JOSHU_AROZ_USER="${user_id}"
    JOSHU_DESKTOP_ROOT="${desktop}"
    JOSHU_FILES_ROOT="${desktop}/${JOSHU_FILES_DIR_NAME}"
    return 0
  done

  for desktop in "${JOSHU_AROZ_DATA}"/files/users/*/Desktop; do
    [[ -d "${desktop}" ]] || continue
    user_id="$(basename "$(dirname "${desktop}")")"
    JOSHU_AROZ_USER="${user_id}"
    JOSHU_DESKTOP_ROOT="${desktop}"
    JOSHU_FILES_ROOT="${desktop}/${JOSHU_FILES_DIR_NAME}"
    return 0
  done
}

write_joshu_files_location_hint() {
  local files_root="$1"
  [[ -n "${files_root}" ]] || return 0
  mkdir -p "${files_root}"
  cat >"${files_root}/LOCATION.md" <<EOF
# Where Joshu stores your files

All files you create or save in the Joshu experience must live **here**:

\`${files_root}\`

Subfolders (see FILING.md):

- \`Triage/\` — work queue stubs (EA)
- \`Projects/\` — active work (\`about.md\`, \`todo.md\`, journals)
- \`connectors/\` — synced mail and calendar mirrors
- \`journals/\` — dated logs
- \`research/\` — notes and investigation
- \`research/kb/inbox/\` — drop PDFs here (auto-extracted to \`research/kb/*.md\`)
- \`inbox/\` — quick capture
- \`uploads/\` — arbitrary uploads

**Do not write to macOS \`~/Desktop\`** — that path is outside ArozOS and will not appear in the Joshu file manager.

Write markdown with Hermes filesystem tools under this folder, e.g. \`journals/YYYY-MM-DD-slug.md\`. gbrain indexes files automatically (path relative to this folder becomes the search slug, e.g. \`journals/YYYY-MM-DD-slug\`).
EOF
}

write_gbrain_source_dotfile() {
  local files_root="$1"
  local source_id="${2:-default}"
  [[ -n "${files_root}" ]] || return 0
  mkdir -p "${files_root}"
  printf '%s\n' "${source_id}" >"${files_root}/.gbrain-source"
}
