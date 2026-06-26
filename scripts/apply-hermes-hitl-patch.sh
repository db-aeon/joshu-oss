#!/usr/bin/env bash
# Apply Joshu HITL Camofox browser patches to the external Hermes checkout.
# Safe to run on every Joshu / dev-arozos start (idempotent).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_DIR="${HERMES_DIR:-/Users/danbenyamin/Documents/dev/hermes-agent}"
PATCH_FILE="${ROOT}/scripts/hermes-browser-camofox-hitl.patch"
RESYNC_SCRIPT="${ROOT}/scripts/patch-hermes-camofox-tab-resync.mjs"

cd "${HERMES_DIR}"

if ! rg -q "HITL_CAMOFOX_USER_ID|CAMOFOX_USER_ID" tools/browser_camofox.py 2>/dev/null \
  || ! rg -q "_adopt_existing_tab" tools/browser_camofox.py 2>/dev/null; then
  echo "[hermes-patch] applying ${PATCH_FILE} to ${HERMES_DIR}"
  patch --forward -p1 < "${PATCH_FILE}"
else
  echo "[hermes-patch] Hermes already has Joshu HITL Camofox tab adoption."
fi

RESYNC_OUT="$(node "${RESYNC_SCRIPT}" tools/browser_camofox.py 2>&1)" || {
  echo "${RESYNC_OUT}" >&2
  exit 1
}
echo "${RESYNC_OUT}"
RESYNC_APPLIED=0
if [[ "${RESYNC_OUT}" == *"applied Camofox tab resync patch"* ]]; then
  RESYNC_APPLIED=1
fi

ENSURE_SCRIPT="${ROOT}/scripts/patch-hermes-camofox-ensure-tab.mjs"
ENSURE_OUT="$(node "${ENSURE_SCRIPT}" tools/browser_camofox.py 2>&1)" || {
  echo "${ENSURE_OUT}" >&2
  exit 1
}
echo "${ENSURE_OUT}"
if [[ "${ENSURE_OUT}" == *"applied Camofox ensure-tab guard"* ]]; then
  RESYNC_APPLIED=1
fi

ACTION_GUARD_SCRIPT="${ROOT}/scripts/patch-hermes-camofox-action-guard.mjs"
ACTION_GUARD_OUT="$(node "${ACTION_GUARD_SCRIPT}" tools/browser_camofox.py 2>&1)" || {
  echo "${ACTION_GUARD_OUT}" >&2
  exit 1
}
echo "${ACTION_GUARD_OUT}"
if [[ "${ACTION_GUARD_OUT}" == *"applied Camofox action-guard patch"* ]]; then
  RESYNC_APPLIED=1
fi

TERMINAL_MAIL_GUARD_SCRIPT="${ROOT}/scripts/patch-hermes-terminal-mail-guard.mjs"
TERMINAL_MAIL_GUARD_OUT="$(node "${TERMINAL_MAIL_GUARD_SCRIPT}" tools/terminal_tool.py 2>&1)" || {
  echo "${TERMINAL_MAIL_GUARD_OUT}" >&2
  exit 1
}
echo "${TERMINAL_MAIL_GUARD_OUT}"
if [[ "${TERMINAL_MAIL_GUARD_OUT}" == *"applied terminal mail-guard patch"* ]]; then
  RESYNC_APPLIED=1
fi

if [[ "${RESYNC_APPLIED}" -eq 1 ]]; then
  echo "[hermes-patch] Hermes browser patches changed — restart Hermes gateway"
  exit 2
fi
