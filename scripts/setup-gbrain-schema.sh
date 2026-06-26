#!/usr/bin/env bash
# Apply the Joshu gbrain schema pack (journal, research, inbox, upload). Idempotent best-effort.
set -euo pipefail

GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
DEFAULT_JOSHU_FILES_DIR="joshu's files"
JOSHU_FILES_DIR_NAME="${JOSHU_FILES_DIR_NAME:-${DEFAULT_JOSHU_FILES_DIR}}"

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

apply_type() {
  local name="$1"
  local prefix="$2"
  shift 2
  if run_gbrain schema stats 2>/dev/null | grep -q "\"${name}\""; then
    return 0
  fi
  # Prefixes are relative to sync.repo_path (JOSHU_FILES_ROOT), not Desktop.
  run_gbrain schema add-type "${name}" --prefix "${prefix}/" "$@" || true
}

# Remove legacy Desktop-nested prefixes and ensure paths relative to JOSHU_FILES_ROOT.
repair_prefix() {
  local type_name="$1"
  local prefix="$2"
  local legacy
  for legacy in \
    "Joshu's Files/${prefix}/" \
    "joshu's files/${prefix}/" \
    "${prefix}/" \
    ; do
    run_gbrain schema remove-prefix "${type_name}" "${legacy}" --pack joshu 2>/dev/null || true
  done
  run_gbrain schema add-prefix "${type_name}" "${prefix}/" --pack joshu 2>/dev/null || true
}

echo "[gbrain-schema] applying joshu schema pack"
run_gbrain schema fork gbrain-base joshu 2>/dev/null || true
run_gbrain schema use joshu 2>/dev/null || true

apply_type journal journals --primitive temporal --extractable
apply_type research research --primitive annotation --extractable
apply_type inbox inbox --primitive annotation
apply_type upload uploads --primitive annotation
apply_type connector-mail connectors/mail --primitive annotation --extractable
apply_type connector-calendar connectors/calendar --primitive annotation --extractable

repair_prefix journal journals
repair_prefix research research
repair_prefix inbox inbox
repair_prefix upload uploads
repair_prefix connector-mail connectors/mail
repair_prefix connector-calendar connectors/calendar

# Obsolete chief pack type from removed joshu-chief templates.
run_gbrain schema remove-type chief-brief --pack joshu 2>/dev/null || true

run_gbrain schema sync --apply 2>/dev/null || true
echo "[gbrain-schema] done"
