#!/usr/bin/env bash
# Apply the Joshu gbrain schema pack (journal, research, inbox, upload). Idempotent best-effort.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"

run_gbrain() {
  (
    unset DATABASE_URL GBRAIN_DATABASE_URL
    "${GBRAIN_BIN}" "$@"
  )
}

if ! command -v "${GBRAIN_BIN}" >/dev/null 2>&1; then
  echo "[gbrain-schema] ${GBRAIN_BIN} not found; skipping"
  exit 0
fi

echo "[gbrain-schema] applying joshu schema pack"
run_gbrain schema fork gbrain-base joshu 2>/dev/null || true
run_gbrain schema use joshu 2>/dev/null || true

# Joshu types first, with prefixes for the real Desktop layout (journals live at
# Projects/<p>/journal_*.md, triage under Triage/). See lib/gbrain-joshu-pack.mjs.
pack_path="${GBRAIN_HOME:-${HOME}/.gbrain}/.gbrain/schema-packs/joshu/pack.json"
if [[ -n "${pack_path}" && -f "${pack_path}" ]]; then
  node "${SCRIPT_DIR}/lib/gbrain-joshu-pack.mjs" "${pack_path}" || true
  run_gbrain schema validate joshu >/dev/null 2>&1 || echo "[gbrain-schema] WARN: joshu pack failed validation" >&2
  run_gbrain schema reload --pack joshu >/dev/null 2>&1 || true
else
  echo "[gbrain-schema] WARN: joshu pack path not found; types left as-is" >&2
fi

# Obsolete chief pack type from removed joshu-chief templates.
run_gbrain schema remove-type chief-brief --pack joshu 2>/dev/null || true

run_gbrain schema sync --apply 2>/dev/null || true
echo "[gbrain-schema] done"
