#!/usr/bin/env bash
# Joshu ArozOS desktop shortcuts — shared by dev-arozos and vps-start.
# Requires AROZ_DATA. See docs/arozos-desktop-shortcuts.md.

JWEB_SHORTCUT_CONTENT=$'module\njWeb\njWeb\nimg/joshu/browser.png\n'
JCHAT_SHORTCUT_CONTENT=$'module\njChat\njChat\nimg/joshu/chat.png\n'
JWHITEBOARD_SHORTCUT_CONTENT=$'module\njWhiteboard\njWhiteboard\nimg/joshu/whiteboard.png\n'
# Stock ArozOS shortcuts: line 2 = display label, line 3 = module name (openModule target).
FILES_SHORTCUT_CONTENT=$'module\nFiles\nFile Manager\nimg/joshu/file-manager.png\n'
SETTINGS_SHORTCUT_CONTENT=$'module\nSettings\nSystem Setting\nimg/joshu/system-setting.png\n'
TRASH_SHORTCUT_CONTENT=$'module\nTrash\nTrash Bin\nimg/joshu/trash.png\n'
MEMORY_SHORTCUT_CONTENT=$'module\nMemory\nMemory\nimg/joshu/hindsight.png\n'
FILE_BRAIN_SHORTCUT_CONTENT=$'module\nFile Brain\nFile Brain\nimg/joshu/file-manager.png\n'
JMOVIE_SHORTCUT_CONTENT=$'module\njMovie\njMovie\nimg/joshu/movie.png\n'
JMAIL_SHORTCUT_CONTENT=$'module\njMail\njMail\nimg/joshu/mail.png\n'
SCHEDULES_SHORTCUT_CONTENT=$'module\nSchedules\nSchedules\nimg/joshu/schedules.png\n'
WELCOME_SHORTCUT_CONTENT=$'module\nWelcome\nWelcome\nimg/joshu/chat.png\n'
CONNECTORS_SHORTCUT_CONTENT=$'module\nConnectors\nConnectors\nimg/joshu/connectors.png\n'
SAFETY_SHORTCUT_CONTENT=$'module\nSafety\nSafety\nimg/joshu/system-setting.png\n'
HERMES_ADMIN_DASHBOARD_PATH="${PUBLIC_BASE_PATH:-/joshu}/hermes-admin/"

install_hermes_admin_shortcuts() {
  local admin_path="${JOSHU_HERMES_DASHBOARD_SHORTCUT_PATH:-${HERMES_ADMIN_DASHBOARD_PATH}}"
  local content=$'url\nHermes Admin\n'"${admin_path}"$'\nimg/joshu/system-setting.png\n'
  _write_desktop_shortcut "Hermes Admin.shortcut" "${content}"
}

# Subservice dirs baked into AROZ_TEMPLATE and refreshed on each boot.
JOSHU_AROZ_SUBSERVICE_IDS=(
  joshu
  excalidraw
  hermes-chat
  hindsight-viewer
  file-brain-viewer
  schedules
  jmovie
  jmail
  connectors
  safety-settings
  welcome
)

_write_desktop_shortcut() {
  local rel_path="$1"
  local content="$2"
  local template_shortcut="${AROZ_DATA}/system/desktop/template/${rel_path}"
  mkdir -p "$(dirname "${template_shortcut}")"
  printf '%s' "${content}" > "${template_shortcut}"

  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    if [[ -d "${user_desktop}" ]]; then
      printf '%s' "${content}" > "${user_desktop}/${rel_path}"
      chmod 755 "${user_desktop}/${rel_path}" || true
    fi
  done
}

install_files_shortcuts() {
  rm -f "${AROZ_DATA}/system/desktop/template/Files.shortcut"
  _write_desktop_shortcut "File Manager.shortcut" "${FILES_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Files.shortcut" || true
  done
}

install_settings_shortcuts() {
  rm -f "${AROZ_DATA}/system/desktop/template/Settings.shortcut"
  _write_desktop_shortcut "System Setting.shortcut" "${SETTINGS_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Settings.shortcut" || true
  done
}

install_trash_shortcuts() {
  rm -f "${AROZ_DATA}/system/desktop/template/Trash.shortcut"
  _write_desktop_shortcut "Trash Bin.shortcut" "${TRASH_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Trash.shortcut" || true
  done
}

install_jweb_shortcuts() {
  rm -f "${AROZ_DATA}/system/desktop/template/Joshu Browser.shortcut"
  _write_desktop_shortcut "jWeb.shortcut" "${JWEB_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Joshu Browser.shortcut" || true
  done
}

install_jwhiteboard_shortcuts() {
  rm -f "${AROZ_DATA}/system/desktop/template/Excalidraw.shortcut"
  _write_desktop_shortcut "jWhiteboard.shortcut" "${JWHITEBOARD_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Excalidraw.shortcut" || true
  done
}

install_jchat_shortcuts() {
  rm -f "${AROZ_DATA}/system/desktop/template/Hermes Chat.shortcut"
  _write_desktop_shortcut "jChat.shortcut" "${JCHAT_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Hermes Chat.shortcut" || true
  done
}

install_memory_shortcuts() {
  rm -f "${AROZ_DATA}/system/desktop/template/Hindsight Viewer.shortcut"
  _write_desktop_shortcut "Memory.shortcut" "${MEMORY_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Hindsight Viewer.shortcut" || true
  done
}

install_file_brain_shortcuts() {
  _write_desktop_shortcut "File Brain.shortcut" "${FILE_BRAIN_SHORTCUT_CONTENT}"
}

install_jmovie_shortcuts() {
  _write_desktop_shortcut "jMovie.shortcut" "${JMOVIE_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Movie.shortcut" || true
  done
}

install_jmail_shortcuts() {
  _write_desktop_shortcut "jMail.shortcut" "${JMAIL_SHORTCUT_CONTENT}"
  local user_desktop
  for user_desktop in "${AROZ_DATA}"/files/users/*/Desktop; do
    rm -f "${user_desktop}/Mail.shortcut" || true
    rm -f "${user_desktop}/jConnect.shortcut" || true
  done
  rm -f "${AROZ_DATA}/system/desktop/template/jConnect.shortcut" || true
}

install_schedules_shortcuts() {
  _write_desktop_shortcut "Schedules.shortcut" "${SCHEDULES_SHORTCUT_CONTENT}"
}

install_welcome_shortcuts() {
  _write_desktop_shortcut "Welcome.shortcut" "${WELCOME_SHORTCUT_CONTENT}"
}

install_connectors_shortcuts() {
  _write_desktop_shortcut "Connectors.shortcut" "${CONNECTORS_SHORTCUT_CONTENT}"
}

install_safety_shortcuts() {
  _write_desktop_shortcut "Safety.shortcut" "${SAFETY_SHORTCUT_CONTENT}"
}

install_all_joshu_desktop_shortcuts() {
  install_files_shortcuts
  install_settings_shortcuts
  install_trash_shortcuts
  install_jweb_shortcuts
  install_jchat_shortcuts
  install_jwhiteboard_shortcuts
  install_memory_shortcuts
  install_file_brain_shortcuts
  install_jmovie_shortcuts
  install_jmail_shortcuts
  install_schedules_shortcuts
  install_connectors_shortcuts
  install_safety_shortcuts
  install_welcome_shortcuts
  if [[ "${JOSHU_HERMES_DASHBOARD_ENABLED:-true}" =~ ^(1|true|yes)$ ]]; then
    install_hermes_admin_shortcuts
  fi
}

sync_joshu_aroz_subservices_from_template() {
  local template="${1:-${AROZ_TEMPLATE}}"
  mkdir -p "${AROZ_DATA}/subservice" "${AROZ_DATA}/web"
  if [[ -d "${template}/web" ]]; then
    rsync -a "${template}/web/" "${AROZ_DATA}/web/"
  else
    echo "[vps-start] WARN: missing ${template}/web — skip subservice web sync" >&2
  fi
  local sub
  for sub in "${JOSHU_AROZ_SUBSERVICE_IDS[@]}"; do
    local src="${template}/subservice/${sub}"
    if [[ ! -d "${src}" ]]; then
      echo "[vps-start] WARN: missing ${src} — skip (image/git mismatch? pull newer JOSHU_IMAGE_REF)" >&2
      continue
    fi
    mkdir -p "${AROZ_DATA}/subservice/${sub}"
    rsync -a "${src}/" "${AROZ_DATA}/subservice/${sub}/"
  done
}
