#!/usr/bin/env bash
# Terminate Kanban workers after complete/block; reap orphan CLI processes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
PATCHER="${SCRIPT_DIR}/patch-hermes-kanban-worker-terminate-on-complete.py"

if [[ ! -f "${HERMES_DIR}/tools/kanban_tools.py" ]]; then
  echo "[hermes-kanban-worker-terminate] skip: Hermes not found under ${HERMES_DIR}"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[hermes-kanban-worker-terminate] error: missing ${PATCHER}" >&2
  exit 1
fi

echo "[hermes-kanban-worker-terminate] applying via patch-hermes-kanban-worker-terminate-on-complete.py"
HERMES_DIR="${HERMES_DIR}" python3 "${PATCHER}"
