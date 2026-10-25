#!/usr/bin/env bash
# Hermes approval prompts: no Always choice and no permanent approvals (change companion-runtime-guard).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-approval-no-permanent.py"

if [[ ! -f "${HERMES_DIR}/tools/approval.py" ]]; then
  echo "[approval-no-permanent] skip: no Hermes tools/approval.py under ${HERMES_DIR}"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[approval-no-permanent] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[approval-no-permanent] applying via patch-hermes-approval-no-permanent.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
