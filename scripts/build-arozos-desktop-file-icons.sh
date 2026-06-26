#!/usr/bin/env bash
# Build Joshu Tango icons for ArozOS desktop + module shortcuts.
#
# Output:
#   arozos/desktop-icons/  → web/img/desktop/  (file types, system_icon)
#   arozos/icons/          → web/img/joshu/     (module + wallpaper folders)
#
# Usage:
#   TANGO_ICONS_ZIP=~/Downloads/tango-icons-for-windows-main.zip \
#     bash scripts/build-arozos-desktop-file-icons.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP="${TANGO_ICONS_ZIP:-${HOME}/Downloads/tango-icons-for-windows-main.zip}"
CACHE="/tmp/tango-icons"
TANGO="${CACHE}/tango-icons-for-windows-main/256x256"
OUT="${ROOT_DIR}/arozos/desktop-icons"
JOSHU_ICONS="${ROOT_DIR}/arozos/icons"
CANVAS=128
GLYPH=104
SMALL_CANVAS=64
SMALL_GLYPH=52
DESKTOP_CANVAS=800
DESKTOP_GLYPH=480

if [[ ! -d "${TANGO}" ]]; then
  mkdir -p "${CACHE}"
  unzip -q -o "${ZIP}" -d "${CACHE}"
fi

# Full 256px library (used + unused) — arozos/tango-icons/
bash "$(dirname "${BASH_SOURCE[0]}")/build-arozos-tango-icon-library.sh"

copy_icon() {
  local rel_dest="$1"
  local rel_src="$2"
  local dest="${OUT}/${rel_dest}"
  local src="${TANGO}/${rel_src}"
  if [[ ! -f "${src}" ]]; then
    echo "[build-arozos-desktop-file-icons] missing source: ${rel_src}" >&2
    return 1
  fi
  mkdir -p "$(dirname "${dest}")"
  ffmpeg -y -loglevel error -i "${src}" \
    -vf "scale=${GLYPH}:${GLYPH}:flags=lanczos,pad=${CANVAS}:${CANVAS}:(ow-iw)/2:(oh-ih)/2:color=0x00000000" \
    "${dest}"
  echo "[build-arozos-desktop-file-icons] ${rel_dest} <- ${rel_src}"
}

copy_icon_small() {
  local rel_dest="$1"
  local rel_src="$2"
  local dest="${OUT}/${rel_dest}"
  local src="${TANGO}/${rel_src}"
  if [[ ! -f "${src}" ]]; then
    echo "[build-arozos-desktop-file-icons] missing source: ${rel_src}" >&2
    return 1
  fi
  mkdir -p "$(dirname "${dest}")"
  ffmpeg -y -loglevel error -i "${src}" \
    -vf "scale=${SMALL_GLYPH}:${SMALL_GLYPH}:flags=lanczos,pad=${SMALL_CANVAS}:${SMALL_CANVAS}:(ow-iw)/2:(oh-ih)/2:color=0x00000000" \
    "${dest}"
  echo "[build-arozos-desktop-file-icons] ${rel_dest} <- ${rel_src}"
}

copy_joshu_module_icon() {
  local name="$1"
  local rel_src="$2"
  local src="${TANGO}/${rel_src}"
  local dest="${JOSHU_ICONS}/${name}"
  if [[ ! -f "${src}" ]]; then
    echo "[build-arozos-desktop-file-icons] missing source: ${rel_src}" >&2
    return 1
  fi
  mkdir -p "${JOSHU_ICONS}"
  ffmpeg -y -loglevel error -i "${src}" \
    -vf "scale=${DESKTOP_GLYPH}:${DESKTOP_GLYPH}:flags=lanczos,pad=${DESKTOP_CANVAS}:${DESKTOP_CANVAS}:(ow-iw)/2:(oh-ih)/2:color=0x00000000" \
    "${dest}"
  echo "[build-arozos-desktop-file-icons] joshu/${name} <- ${rel_src}"
}

# --- files_icon/default (desktop + File Manager file types) ---
FILE_ICON="files_icon/default"

copy_icon "${FILE_ICON}/folder.png" "places/folder.png"
copy_icon "${FILE_ICON}/folder-with-content.png" "status/folder-open.png"
copy_icon "${FILE_ICON}/folder-shortcut.png" "emblems/emblem-symbolic-link.png"
copy_icon "${FILE_ICON}/shared square.png" "places/network-workgroup.png"

copy_icon "${FILE_ICON}/file outline.png" "mimetypes/text-x-generic.png"
copy_icon "${FILE_ICON}/file text outline.png" "mimetypes/x-office-document.png"
copy_icon "${FILE_ICON}/file word outline.png" "mimetypes/x-office-document-template.png"
copy_icon "${FILE_ICON}/file pdf outline.png" "mimetypes/application-certificate.png"
copy_icon "${FILE_ICON}/file excel outline.png" "mimetypes/x-office-spreadsheet.png"
copy_icon "${FILE_ICON}/file powerpoint outline.png" "mimetypes/x-office-presentation.png"
copy_icon "${FILE_ICON}/file image outline.png" "mimetypes/image-x-generic.png"
copy_icon "${FILE_ICON}/file archive outline.png" "mimetypes/package-x-generic.png"
copy_icon "${FILE_ICON}/file audio outline.png" "mimetypes/audio-x-generic.png"
copy_icon "${FILE_ICON}/file video outline.png" "mimetypes/video-x-generic.png"
copy_icon "${FILE_ICON}/file code outline.png" "mimetypes/text-x-script.png"
copy_icon "${FILE_ICON}/external square.png" "emblems/emblem-symbolic-link.png"
copy_icon "${FILE_ICON}/file upload.png" "status/folder-drag-accept.png"
copy_icon "${FILE_ICON}/cube.png" "mimetypes/package-x-generic.png"
copy_icon "${FILE_ICON}/cubes.png" "mimetypes/x-office-drawing.png"

# --- system_icon (executables, shortcuts, shared badge, folders) ---
copy_icon "system_icon/folder.png" "places/folder.png"
copy_icon "system_icon/folder-with-content.png" "status/folder-open.png"
copy_icon "system_icon/folder-shortcut.png" "emblems/emblem-symbolic-link.png"
copy_icon "system_icon/script.png" "mimetypes/application-x-executable.png"
copy_icon "system_icon/shortcut.png" "emblems/emblem-symbolic-link.png"
copy_icon "system_icon/bad_shortcut.png" "status/dialog-error.png"
copy_icon_small "system_icon/shared.png" "status/network-transmit-receive.png"

# --- img/joshu module + wallpaper folder glyphs (800×800) ---
copy_joshu_module_icon "browser.png" "apps/internet-web-browser.png"
copy_joshu_module_icon "chat.png" "apps/internet-group-chat.png"
copy_joshu_module_icon "whiteboard.png" "mimetypes/x-office-drawing.png"
copy_joshu_module_icon "movie.png" "mimetypes/video-x-generic.png"
copy_joshu_module_icon "mail.png" "apps/internet-mail.png"
copy_joshu_module_icon "file-manager.png" "apps/system-file-manager.png"
copy_joshu_module_icon "system-setting.png" "categories/preferences-system.png"
copy_joshu_module_icon "trash.png" "places/user-trash.png"
copy_joshu_module_icon "hindsight.png" "places/folder-saved-search.png"
copy_joshu_module_icon "pictures.png" "mimetypes/image-x-generic.png"
copy_joshu_module_icon "schedules.png" "mimetypes/x-office-calendar.png"
copy_joshu_module_icon "connectors.png" "status/network-transmit-receive.png"
copy_joshu_module_icon "icon-test.png" "status/dialog-information.png"
copy_joshu_module_icon "folder.png" "places/folder.png"
copy_joshu_module_icon "folder-open.png" "status/folder-open.png"

echo "[build-arozos-desktop-file-icons] done -> ${OUT} + ${JOSHU_ICONS}"
