#!/usr/bin/env bash
# Let background skill review patch factory skills under $HERMES_HOME/skills/joshu/.
# See patch-hermes-factory-skill-background-writes.mjs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${HERMES_DIR:-/opt/hermes-agent}"
TARGET="${HERMES_DIR}/tools/skill_manager_tool.py"
PATCHER="${SCRIPT_DIR}/patch-hermes-factory-skill-background-writes.mjs"

if [[ ! -f "${TARGET}" ]]; then
  echo "[factory-skill-background-writes] skip: ${TARGET} not found"
  exit 0
fi

if [[ ! -f "${PATCHER}" ]]; then
  echo "[factory-skill-background-writes] error: missing ${PATCHER}" >&2
  exit 1
fi

node "${PATCHER}" "${TARGET}"
