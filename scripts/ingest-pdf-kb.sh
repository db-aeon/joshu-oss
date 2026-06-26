#!/usr/bin/env bash
# Run KB PDF ingest once (inbox scan). Used by kb-pdf-ingest watcher and manual ops.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
joshu_files_resolve_paths "${APP_DIR}" 2>/dev/null || true

if [[ -z "${JOSHU_FILES_ROOT:-}" ]]; then
  echo "[ingest-pdf-kb] JOSHU_FILES_ROOT unset" >&2
  exit 1
fi

mkdir -p "${JOSHU_FILES_ROOT}/research/kb/inbox" "${JOSHU_FILES_ROOT}/research/kb/.raw"

python3 "${APP_DIR}/scripts/ingest-pdf-kb.py" --files-root "${JOSHU_FILES_ROOT}" "$@"
