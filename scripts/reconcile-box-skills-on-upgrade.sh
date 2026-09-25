#!/usr/bin/env bash
# Reconcile box-evolved Hermes skills after image upgrade + bootstrap merge.
# Strips Camofox workarounds that conflict with Browser Use Cloud fleet rules.
#
# Usage (on box, after recreate):
#   bash /opt/joshu/scripts/reconcile-box-skills-on-upgrade.sh
#   bash /opt/joshu/scripts/reconcile-box-skills-on-upgrade.sh --dry-run
#
# From laptop:
#   bash scripts/reconcile-box-skills-on-upgrade.sh root@<slug>.box.example.com
set -euo pipefail

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  sed -n '2,12p' "$0"
  exit 0
fi

if [[ "${1:-}" == @* || "${1:-}" == *@*.* ]]; then
  TARGET="$1"
  shift
  ssh "${TARGET}" "bash /opt/joshu/scripts/reconcile-box-skills-on-upgrade.sh $*"
  exit 0
fi

APP_DIR="${JOSHU_REPO_ROOT:-/opt/joshu}"
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
SCRIPT="${APP_DIR}/scripts/reconcile-box-skills-on-upgrade.mjs"
NODE_BIN="${NODE_BIN:-node}"

if [[ ! -f "${SCRIPT}" ]]; then
  echo "[skill-reconcile] missing ${SCRIPT}" >&2
  exit 1
fi

# Load fleet browser flag when present
if [[ -f /etc/joshu/instance.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/joshu/instance.env
  set +a
fi

export HERMES_HOME
export JOSHU_REPO_ROOT="${APP_DIR}"

echo "[skill-reconcile] running inside container when possible…"
CID=""
if command -v docker >/dev/null 2>&1 && [[ -f /opt/joshu/deploy/docker-compose.yml ]]; then
  CID="$(docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack 2>/dev/null | head -1 || true)"
fi

if [[ -n "${CID}" ]]; then
  docker exec -e HERMES_HOME=/root/.hermes -e JOSHU_REPO_ROOT=/opt/joshu \
    "${CID}" "${NODE_BIN}" /opt/joshu/scripts/reconcile-box-skills-on-upgrade.mjs "$@"
else
  HERMES_HOME="${HERMES_HOME}" JOSHU_REPO_ROOT="${APP_DIR}" \
    "${NODE_BIN}" "${SCRIPT}" "$@"
fi

echo "[skill-reconcile] nudge Hermes gateway (config reload)…"
if [[ -n "${CID}" ]]; then
  curl -fsS --max-time 30 "http://127.0.0.1:8788/joshu/api/hermes-chat/status?after_mcp_boot=1" >/dev/null || true
fi

echo "[skill-reconcile] complete — start a new jChat session before smoke tests"
