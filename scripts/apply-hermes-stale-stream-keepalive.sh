#!/usr/bin/env bash
# Apply keepalive-aware stale-stream patch to Hermes (box boot + hotpatch).
# See scripts/patch-hermes-stale-stream-keepalive.py and
# docs/vps-sandbox/troubleshooting-and-lessons.md (Slack hang on a fleet box, 2026-08-24).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-stale-stream-keepalive.py"

if [[ ! -f "${HERMES_DIR}/agent/chat_completion_helpers.py" ]]; then
  echo "[hermes-stale-stream-keepalive] skip: missing ${HERMES_DIR}/agent/chat_completion_helpers.py"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-stale-stream-keepalive] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[hermes-stale-stream-keepalive] applying via patch-hermes-stale-stream-keepalive.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
