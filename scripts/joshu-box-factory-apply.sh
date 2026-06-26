#!/usr/bin/env bash
# Idempotent factory profile apply (seeds, structure, LOCATION.md).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/joshu}"
if [[ ! -d "${APP_DIR}/scripts" ]]; then
  APP_DIR="${ROOT_DIR}"
fi

cd "${APP_DIR}"
if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

if [[ -f "${APP_DIR}/packages/box-state/dist/cli.js" ]]; then
  node "${APP_DIR}/packages/box-state/dist/cli.js" factory-apply
elif [[ -x "${APP_DIR}/node_modules/.bin/tsx" ]]; then
  npx tsx packages/box-state/src/cli.ts factory-apply
else
  echo "[joshu-box-factory-apply] WARN: tsx/cli unavailable; mkdir structure only" >&2
  # shellcheck source=lib/joshu-files-paths.sh
  source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
  joshu_files_resolve_paths "${APP_DIR}"
  mkdir -p "${JOSHU_FILES_ROOT:-}"
fi
