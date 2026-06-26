#!/usr/bin/env bash
# Replace local joshu's files tree from a zip (interior = files root contents).
# Usage: bash scripts/import-joshu-files-zip.sh /path/to/archive.zip [--no-reindex]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP_PATH="${1:-}"
SKIP_REINDEX=false

for arg in "${@:2}"; do
  case "${arg}" in
    --no-reindex) SKIP_REINDEX=true ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${ZIP_PATH}" || ! -f "${ZIP_PATH}" ]]; then
  echo "Usage: $0 /path/to/joshu-files.zip [--no-reindex]" >&2
  exit 1
fi

if [[ -f "${APP_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${APP_DIR}/.env"
  set +a
fi

# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
joshu_files_resolve_paths "${APP_DIR}"

if [[ -z "${JOSHU_FILES_ROOT:-}" ]]; then
  echo "[import-joshu-files] could not resolve JOSHU_FILES_ROOT — run bootstrap first" >&2
  exit 1
fi

ISO="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
BACKUP_ROOT="${APP_DIR}/.local/backups/joshu-files-${ISO}"
mkdir -p "$(dirname "${BACKUP_ROOT}")"

if [[ -d "${JOSHU_FILES_ROOT}" ]]; then
  echo "[import-joshu-files] backing up ${JOSHU_FILES_ROOT} -> ${BACKUP_ROOT}"
  cp -a "${JOSHU_FILES_ROOT}" "${BACKUP_ROOT}"
else
  mkdir -p "$(dirname "${JOSHU_FILES_ROOT}")"
fi

echo "[import-joshu-files] removing ${JOSHU_FILES_ROOT}"
rm -rf "${JOSHU_FILES_ROOT}"
mkdir -p "${JOSHU_FILES_ROOT}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "[import-joshu-files] extracting ${ZIP_PATH}"
unzip -q "${ZIP_PATH}" -d "${TMP_DIR}"

# Zip may be flat (Projects/ at root) or wrapped once (joshu's files/Projects/).
SRC="${TMP_DIR}"
if [[ -d "${TMP_DIR}/joshu's files" ]]; then
  SRC="${TMP_DIR}/joshu's files"
elif [[ "$(find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ]]; then
  only="$(find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -1)"
  base="$(basename "${only}")"
  if [[ "${base}" == "joshu's files" || "${base}" == "Joshu's Files" ]]; then
    SRC="${only}"
  fi
fi

if [[ ! -d "${SRC}/Projects" && ! -f "${SRC}/FILING.md" ]]; then
  echo "[import-joshu-files] zip does not look like joshu's files interior (missing Projects/ or FILING.md)" >&2
  exit 1
fi

echo "[import-joshu-files] copying into ${JOSHU_FILES_ROOT}"
# Copy including dotfiles; trailing /. merges contents into destination.
cp -a "${SRC}/." "${JOSHU_FILES_ROOT}/"

echo "[import-joshu-files] factory seeds (missing only)"
bash "${APP_DIR}/scripts/bootstrap-joshu-files.sh"

write_joshu_files_location_hint "${JOSHU_FILES_ROOT}"
write_gbrain_source_dotfile "${JOSHU_FILES_ROOT}" "${GBRAIN_SOURCE:-default}"

FILE_COUNT="$(find "${JOSHU_FILES_ROOT}" -type f | wc -l | tr -d ' ')"
echo "[import-joshu-files] done — ${FILE_COUNT} files at ${JOSHU_FILES_ROOT}"
echo "[import-joshu-files] backup at ${BACKUP_ROOT}"

if [[ "${SKIP_REINDEX}" == "true" ]]; then
  echo "[import-joshu-files] skipping gbrain reindex (--no-reindex)"
  exit 0
fi

if [[ -x "${APP_DIR}/scripts/ensure-gbrain-indexed.sh" ]]; then
  echo "[import-joshu-files] gbrain reindex (full)"
  APP_DIR="${APP_DIR}" bash "${APP_DIR}/scripts/ensure-gbrain-indexed.sh" --full || {
    echo "[import-joshu-files] warn: gbrain reindex failed — restart dev stack or run ensure-gbrain-indexed.sh manually" >&2
  }
fi
