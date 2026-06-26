#!/usr/bin/env bash
# E2E: write markdown under JOSHU_FILES_ROOT, sync into gbrain, search finds it.
# Run while dev:arozos is STOPPED (PGLite single-holder). Hermes uses gbrain-mcp-readonly-proxy at runtime.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/joshu-files-paths.sh
source "${ROOT_DIR}/scripts/lib/joshu-files-paths.sh"

export APP_DIR="${ROOT_DIR}"
export AROZ_DATA="${AROZ_DATA:-${ROOT_DIR}/.local/arozos-data}"
export GBRAIN_HOME="${GBRAIN_HOME:-${ROOT_DIR}/.local/gbrain}"
export GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
export PATH="${HOME}/.bun/bin:${PATH}"

if ! command -v "${GBRAIN_BIN}" >/dev/null 2>&1; then
  echo "[test-fs-brain] skip: ${GBRAIN_BIN} not found"
  exit 0
fi

if pgrep -f "gbrain-mcp-readonly-proxy" >/dev/null 2>&1 || pgrep -f "gbrain serve" >/dev/null 2>&1; then
  echo "[test-fs-brain] skip: gbrain serve/proxy already running (PGLite lock). Stop dev:arozos and re-run."
  exit 0
fi

joshu_files_resolve_paths "${ROOT_DIR}" || true
if [[ -z "${JOSHU_FILES_ROOT:-}" ]]; then
  echo "[test-fs-brain] skip: JOSHU_FILES_ROOT unresolved (set JOSHU_AROZ_USER or bootstrap ArozOS user)"
  exit 0
fi

run_gbrain() {
  (
    unset DATABASE_URL GBRAIN_DATABASE_URL
    export GBRAIN_HOME
    "${GBRAIN_BIN}" "$@"
  )
}

MARKER="joshu-fs-brain-e2e-$(date +%s)-$$"
SLUG="journals/${MARKER}"
FILE="${JOSHU_FILES_ROOT}/${SLUG}.md"

mkdir -p "$(dirname "${FILE}")"
cat >"${FILE}" <<EOF
---
title: E2E filesystem brain test
date: $(date +%Y-%m-%d)
type: journal
---

Unique marker: ${MARKER}
EOF

echo "[test-fs-brain] wrote ${FILE}"
echo "[test-fs-brain] syncing ${JOSHU_FILES_ROOT}…"
run_gbrain config set sync.repo_path "${JOSHU_FILES_ROOT}" 2>/dev/null || true
run_gbrain sync --apply 2>/dev/null || run_gbrain sync --apply --repo "${JOSHU_FILES_ROOT}" 2>/dev/null
run_gbrain embed --stale 2>/dev/null || true

FOUND=0
for attempt in 1 2 3 4 5; do
  if run_gbrain search "${MARKER}" --limit 5 2>/dev/null | grep -q "${MARKER}"; then
    FOUND=1
    break
  fi
  echo "[test-fs-brain] attempt ${attempt}: not indexed yet"
  sleep 2
done

rm -f "${FILE}"
run_gbrain sync --apply 2>/dev/null || true

if [[ "${FOUND}" -eq 1 ]]; then
  echo "[test-fs-brain] ok: search found ${MARKER}"
  exit 0
fi

echo "[test-fs-brain] FAIL: marker not found after sync" >&2
exit 1
