#!/usr/bin/env bash
# Apply Joshu no-training routing patch (OpenRouter data_collection) to the Hermes checkout.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCHER="${SCRIPT_DIR}/patch-hermes-openrouter-data-collection.py"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-openrouter-data-collection] missing patcher: ${PATCHER}" >&2
  exit 1
fi

if [[ ! -d "${HERMES_DIR}" ]]; then
  echo "[hermes-openrouter-data-collection] skip — HERMES_DIR not found: ${HERMES_DIR}" >&2
  exit 0
fi

HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
