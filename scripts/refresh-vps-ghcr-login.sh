#!/usr/bin/env bash
# Re-authenticate docker against GHCR on a VPS host (e.g. after GHCR_READ_TOKEN rotation).
#
# Run on the box as root (or via SSH):
#   GHCR_READ_USER=db-aeon GHCR_READ_TOKEN=ghp_... bash /opt/joshu/scripts/refresh-vps-ghcr-login.sh
#
# Then recreate instance-agent so admin "Update release" pulls succeed:
#   docker compose -f /opt/joshu/deploy/docker-compose.yml --env-file /etc/joshu/instance.env \
#     up -d --force-recreate instance-agent
#
# Verify from inside the agent:
#   docker exec deploy-instance-agent-1 docker pull ghcr.io/db-aeon/joshu-sandbox:<tag>
set -euo pipefail

REGISTRY_HOST="${GHCR_REGISTRY:-ghcr.io}"
REGISTRY_USER="${GHCR_READ_USER:-}"
REGISTRY_TOKEN="${GHCR_READ_TOKEN:-}"

if [[ -z "${REGISTRY_USER}" || -z "${REGISTRY_TOKEN}" ]] && [[ -f /etc/joshu/secrets/ghcr-read.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/joshu/secrets/ghcr-read.env
  set +a
  REGISTRY_HOST="${GHCR_REGISTRY:-ghcr.io}"
  REGISTRY_USER="${GHCR_READ_USER:-}"
  REGISTRY_TOKEN="${GHCR_READ_TOKEN:-}"
fi

if [[ -z "${REGISTRY_USER}" || -z "${REGISTRY_TOKEN}" ]]; then
  echo "[ghcr-login] GHCR_READ_USER and GHCR_READ_TOKEN are required (env or /etc/joshu/secrets/ghcr-read.env)" >&2
  exit 1
fi

echo "[ghcr-login] logging in to ${REGISTRY_HOST} as ${REGISTRY_USER}"
echo "${REGISTRY_TOKEN}" | docker login "${REGISTRY_HOST}" -u "${REGISTRY_USER}" --password-stdin
echo "[ghcr-login] done — host ~/.docker/config.json updated"
