#!/usr/bin/env bash
# Push PROXY_* from repo .env to a box's /etc/joshu/instance.env and recreate joshu-stack.
# Usage: bash scripts/sync-camofox-proxy-to-vps.sh clara
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${1:?usage: sync-camofox-proxy-to-vps.sh <slug>}"
SSH_HOST="${SYNC_BOX_SSH_HOST:-${SLUG}.box.joshu.me}"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[sync-camofox-proxy] missing ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "${ENV_FILE}"
set +a

if [[ -z "${PROXY_HOST:-}" && -z "${PROXY_BACKCONNECT_HOST:-}" ]]; then
  echo "[sync-camofox-proxy] set PROXY_HOST or PROXY_BACKCONNECT_HOST in ${ENV_FILE}" >&2
  exit 1
fi

PATCH_ARGS=()
for key in PROXY_STRATEGY PROXY_PROVIDER PROXY_HOST PROXY_PORT PROXY_PORTS \
  PROXY_USERNAME PROXY_PASSWORD PROXY_BACKCONNECT_HOST PROXY_BACKCONNECT_PORT \
  PROXY_COUNTRY PROXY_STATE PROXY_CITY PROXY_ZIP PROXY_SESSION_DURATION_MINUTES; do
  if [[ -n "${!key:-}" ]]; then
    PATCH_ARGS+=("${key}=${!key}")
  fi
done

echo "[sync-camofox-proxy] patching ${SSH_HOST} (${#PATCH_ARGS[@]} keys, proxy host=${PROXY_HOST:-${PROXY_BACKCONNECT_HOST}})"

# Build remote patch command without echoing password to logs.
REMOTE_PATCH="cd /opt/joshu && git pull --ff-only && docker run --rm -v /opt/joshu:/opt/joshu -v /etc/joshu:/etc/joshu node:22-bookworm-slim node /opt/joshu/scripts/patch-instance-env.mjs"
for arg in "${PATCH_ARGS[@]}"; do
  REMOTE_PATCH+=" $(printf '%q' "${arg}")"
done
REMOTE_PATCH+=" && docker compose -f deploy/docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack"
REMOTE_PATCH+=" && sleep 12 && docker logs --tail 15 deploy-joshu-stack-1 2>&1 | grep -iE 'proxy pool|no proxy' || true"

ssh -o ConnectTimeout=20 "root@${SSH_HOST}" "${REMOTE_PATCH}"

echo "[sync-camofox-proxy] done — open noVNC and try slack.com/signin"
