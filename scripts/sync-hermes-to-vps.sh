#!/usr/bin/env bash
# Sync Hermes provider + gateway env from repo root .env into a VPS instance.env, then recreate stack.
# Usage: ./scripts/sync-hermes-to-vps.sh root@11-21-10.box.joshu.me
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
VPS_TARGET="${1:-}"

if [[ -z "${VPS_TARGET}" ]]; then
  echo "usage: $0 root@<ip-or-hostname>" >&2
  exit 1
fi

VPS_HOST="${VPS_TARGET}"
if [[ "${VPS_HOST}" != *@* ]]; then
  VPS_HOST="root@${VPS_HOST}"
fi
host_part="${VPS_HOST#*@}"
if [[ "${host_part}" =~ ^[0-9.]+$ ]]; then
  :
elif command -v dig >/dev/null 2>&1; then
  resolved="$(dig +short "${host_part}" A 2>/dev/null | head -n 1)"
  if [[ -n "${resolved}" ]]; then
    VPS_HOST="root@${resolved}"
    echo "Resolved ${host_part} -> ${resolved}"
  fi
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "missing ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a && source "${ENV_FILE}" && set +a

OPENROUTER_KEY="${DEFAULT_OPENROUTER_API_KEY:-${OPENROUTER_API_KEY:-}}"
HERMES_MODEL="${DEFAULT_JOSHU_HERMES_MODEL:-${JOSHU_HERMES_MODEL:-deepseek/deepseek-v4-flash}}"
HERMES_PROVIDER="${DEFAULT_JOSHU_HERMES_PROVIDER:-${JOSHU_HERMES_PROVIDER:-openrouter}}"

if [[ -z "${OPENROUTER_KEY}" ]]; then
  echo "Set OPENROUTER_API_KEY in ${ENV_FILE} or DEFAULT_OPENROUTER_API_KEY in apps/control-plane/.env.local" >&2
  exit 1
fi

tmp="$(mktemp)"
{
  echo "JOSHU_HERMES_MODEL=${HERMES_MODEL}"
  echo "JOSHU_HERMES_PROVIDER=${HERMES_PROVIDER}"
  echo "OPENROUTER_API_KEY=${OPENROUTER_KEY}"
} >"${tmp}"

scp "${tmp}" "${VPS_HOST}:/tmp/joshu-hermes.env"
rm -f "${tmp}"

ssh "${VPS_HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail
touch /etc/joshu/instance.env
chmod 600 /etc/joshu/instance.env
grep -v -E '^(JOSHU_HERMES_MODEL|JOSHU_HERMES_PROVIDER|OPENROUTER_API_KEY|ANTHROPIC_API_KEY)=' /etc/joshu/instance.env > /tmp/instance.env.clean || true
cat /tmp/instance.env.clean /tmp/joshu-hermes.env > /etc/joshu/instance.env
rm -f /tmp/instance.env.clean /tmp/joshu-hermes.env

cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
sleep 12
if docker ps --format '{{.Names}}' | grep -q '^deploy-joshu-stack-1$'; then
  docker exec deploy-joshu-stack-1 bash -lc '
    set -euo pipefail
    set -a && source /etc/joshu/instance.env && set +a
    H=/root/.hermes/.env
    grep -v -E "^(OPENROUTER_API_KEY|ANTHROPIC_API_KEY|HERMES_API_KEY|API_SERVER_KEY)=" "${H}" 2>/dev/null > /tmp/hermes.env.clean || true
    {
      cat /tmp/hermes.env.clean 2>/dev/null || true
      echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
      echo "HERMES_API_KEY=${HERMES_API_KEY}"
      echo "API_SERVER_KEY=${API_SERVER_KEY}"
    } > "${H}"
    chmod 600 "${H}"
    kill $(cat /root/.hermes/gateway.pid 2>/dev/null) 2>/dev/null || true
    pkill -f "hermes gateway" 2>/dev/null || true
    rm -f /root/.hermes/gateway.pid /root/.hermes/gateway.lock
    grep -E "^model:" -A3 /root/.hermes/config.yaml 2>/dev/null || echo "(config.yaml model block written on gateway start)"
  '
fi
REMOTE

echo "Hermes env synced on ${VPS_HOST}. Wait ~30s, then test chat or:"
echo "  curl -fsS https://<host>/joshu/api/instance/health | jq '.components.hermes'"
