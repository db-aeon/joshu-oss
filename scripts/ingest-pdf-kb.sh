#!/usr/bin/env bash
# Run PDF → sibling-markdown ingest once (full Desktop scan). Used by watcher and manual ops.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=lib/joshu-files-paths.sh
source "${APP_DIR}/scripts/lib/joshu-files-paths.sh"
joshu_files_resolve_paths "${APP_DIR}" 2>/dev/null || true

# Prefer Desktop root so PDFs outside joshu's files are included (same scope as gbrain).
SCAN_ROOT="${JOSHU_DESKTOP_ROOT:-${JOSHU_FILES_ROOT:-}}"
if [[ -z "${SCAN_ROOT}" ]]; then
  echo "[ingest-pdf-kb] JOSHU_DESKTOP_ROOT unset" >&2
  exit 1
fi

python3 "${APP_DIR}/scripts/ingest-pdf-kb.py" --root "${SCAN_ROOT}" "$@"
