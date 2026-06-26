#!/usr/bin/env bash
# One-shot repair when admin "Update release" keeps failing (usually stale GHCR login).
#
# Run on the VPS as root (SSH):
#   cd /opt/joshu && git pull && bash scripts/repair-vps-admin-update.sh
#
# Optional: pass target image tag to pull/recreate stack after agent repair:
#   JOSHU_IMAGE_REF=ghcr.io/db-aeon/joshu-sandbox:0.1.22 bash scripts/repair-vps-admin-update.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${JOSHU_COMPOSE_FILE:-${ROOT_DIR}/deploy/docker-compose.yml}"
ENV_FILE="${JOSHU_COMPOSE_ENV_FILE:-/etc/joshu/instance.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[repair-vps-admin-update] missing ${ENV_FILE}" >&2
  exit 1
fi

if ! grep -q '/root/.docker:/root/.docker' "${COMPOSE_FILE}"; then
  echo "[repair-vps-admin-update] ${COMPOSE_FILE} must mount /root/.docker for instance-agent" >&2
  exit 1
fi

echo "[repair-vps-admin-update] refreshing GHCR login"
bash "${ROOT_DIR}/scripts/refresh-vps-ghcr-login.sh"

build_host_instance_agent() {
  if command -v npm >/dev/null 2>&1; then
    (
      cd "${ROOT_DIR}/packages/instance-agent"
      npm ci --omit=dev 2>/dev/null || npm install --omit=dev
      npm run build
    )
    return
  fi

  echo "[repair-vps-admin-update] no host npm — docker compose build instance-agent + copy dist to /opt/joshu"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" build instance-agent
  local image_id
  image_id="$(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" images -q instance-agent | head -1)"
  if [[ -z "${image_id}" ]]; then
    echo "[repair-vps-admin-update] instance-agent image id not found after build" >&2
    exit 1
  fi
  local tmp_cid
  tmp_cid="$(docker create "${image_id}")"
  rm -rf "${ROOT_DIR}/packages/instance-agent/dist" "${ROOT_DIR}/packages/instance-agent/node_modules"
  docker cp "${tmp_cid}:/app/dist" "${ROOT_DIR}/packages/instance-agent/dist"
  docker cp "${tmp_cid}:/app/node_modules" "${ROOT_DIR}/packages/instance-agent/node_modules"
  docker rm "${tmp_cid}" >/dev/null
}

echo "[repair-vps-admin-update] rebuilding host instance-agent (compose runs /opt/joshu/scripts/run-instance-agent.mjs)"
build_host_instance_agent
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --force-recreate instance-agent

echo "[repair-vps-admin-update] verifying pull from inside instance-agent"
AGENT_CID="$(docker ps -qf name=instance-agent | head -1)"
if [[ -n "${AGENT_CID}" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ENV_FILE}"
  set +a
  docker exec "${AGENT_CID}" docker pull "${JOSHU_IMAGE_REF}"
fi

if [[ -n "${JOSHU_IMAGE_REF:-}" && "${JOSHU_IMAGE_REF}" != "$(grep -E '^JOSHU_IMAGE_REF=' "${ENV_FILE}" | tail -1 | cut -d= -f2-)" ]]; then
  echo "[repair-vps-admin-update] JOSHU_IMAGE_REF env override ignored for stack — use admin Update after repair"
fi

echo "[repair-vps-admin-update] done — retry admin Update release (control plane must inject registryAuth on heartbeat)"
