#!/usr/bin/env bash
# Apply Joshu browser and terminal guard patches to the external Hermes checkout:
# the CDP browser guards (tools/browser_tool.py) and the terminal mail and secrets
# guards (tools/terminal_tool.py). The Camofox patches are gone (change remove-camofox).
# Safe to run on every Joshu / dev-arozos start (idempotent).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_DIR="${HERMES_DIR:-/Users/danbenyamin/Documents/dev/hermes-agent}"
cd "${HERMES_DIR}"

RESYNC_APPLIED=0

CDP_GUARD_SCRIPT="${ROOT}/scripts/patch-hermes-browser-cdp-guards.mjs"
CDP_GUARD_OUT="$(node "${CDP_GUARD_SCRIPT}" tools/browser_tool.py 2>&1)" || {
  echo "${CDP_GUARD_OUT}" >&2
  exit 1
}
echo "${CDP_GUARD_OUT}"
if [[ "${CDP_GUARD_OUT}" == *"applied CDP browser handoff lock"* ]]; then
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

TERMINAL_SECRETS_GUARD_SCRIPT="${ROOT}/scripts/patch-hermes-terminal-secrets-guard.mjs"
TERMINAL_SECRETS_GUARD_OUT="$(node "${TERMINAL_SECRETS_GUARD_SCRIPT}" tools/terminal_tool.py 2>&1)" || {
  echo "${TERMINAL_SECRETS_GUARD_OUT}" >&2
  exit 1
}
echo "${TERMINAL_SECRETS_GUARD_OUT}"
if [[ "${TERMINAL_SECRETS_GUARD_OUT}" == *"applied terminal secrets-guard patch"* ]]; then
  RESYNC_APPLIED=1
fi

if [[ "${RESYNC_APPLIED}" -eq 1 ]]; then
  echo "[hermes-patch] Hermes guard patches changed — restart Hermes gateway"
  exit 2
fi
