#!/usr/bin/env bash
# Hermes pairing reply: tell the owner to enter the code in the Safety app.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-pairing-reply.py"

if [[ ! -f "${HERMES_DIR}/gateway/run.py" ]]; then
  echo "[pairing-reply] skip: no Hermes gateway under ${HERMES_DIR}"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[pairing-reply] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[pairing-reply] applying via patch-hermes-pairing-reply.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
