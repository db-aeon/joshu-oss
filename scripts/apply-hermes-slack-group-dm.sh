#!/usr/bin/env bash
# Hermes Slack adapter: the owner can address the companion by name in a group DM (issue #170).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-slack-group-dm.py"

if [[ ! -f "${HERMES_DIR}/plugins/platforms/slack/adapter.py" ]]; then
  echo "[slack-group-dm] skip: no Hermes Slack adapter under ${HERMES_DIR}"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[slack-group-dm] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[slack-group-dm] applying via patch-hermes-slack-group-dm.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
