#!/usr/bin/env bash
# Operator hotfix: pull 0.1.26, sync dist + email-signature from image, recreate stack.
# Usage on box: bash /opt/joshu/scripts/hotfix-box-to-0.1.26.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/joshu}"
DEPLOY_DIR="${APP_DIR}/deploy"
ENV_FILE="${JOSHU_COMPOSE_ENV_FILE:-/etc/joshu/instance.env}"
IMAGE="ghcr.io/db-aeon/joshu-sandbox:0.1.26"
COMPOSE=(docker compose -f "${DEPLOY_DIR}/docker-compose.yml" --env-file "${ENV_FILE}")

log() { printf '[hotfix-0.1.26] %s\n' "$*"; }

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "missing ${ENV_FILE}" >&2
  exit 1
fi

log "git pull (host scripts + skills + factory manifest)"
git -C "${APP_DIR}" pull --ff-only origin main || git -C "${APP_DIR}" pull --ff-only || true

log "copy email-signature dist from image"
CID=$(docker create "${IMAGE}")
mkdir -p "${APP_DIR}/packages/email-signature"
docker cp "${CID}:/opt/joshu/packages/email-signature/dist" "${APP_DIR}/packages/email-signature/"
docker rm "${CID}" >/dev/null

if [[ -x "${APP_DIR}/scripts/sync-dist-from-image.sh" ]]; then
  log "sync dist from ${IMAGE}"
  JOSHU_IMAGE_REF="${IMAGE}" JOSHU_RELEASE_VERSION=0.1.26 \
    bash "${APP_DIR}/scripts/sync-dist-from-image.sh"
fi

log "patch instance.env image ref"
if grep -q '^JOSHU_IMAGE_REF=' "${ENV_FILE}"; then
  sed -i 's|^JOSHU_IMAGE_REF=.*|JOSHU_IMAGE_REF='"${IMAGE}"'|' "${ENV_FILE}"
else
  echo "JOSHU_IMAGE_REF=${IMAGE}" >> "${ENV_FILE}"
fi
if grep -q '^JOSHU_RELEASE_VERSION=' "${ENV_FILE}"; then
  sed -i 's|^JOSHU_RELEASE_VERSION=.*|JOSHU_RELEASE_VERSION=0.1.26|' "${ENV_FILE}"
else
  echo "JOSHU_RELEASE_VERSION=0.1.26" >> "${ENV_FILE}"
fi

log "pull + recreate joshu-stack"
cd "${DEPLOY_DIR}"
"${COMPOSE[@]}" pull joshu-stack
"${COMPOSE[@]}" up -d --force-recreate joshu-stack

log "done — watch: ${COMPOSE[*]} logs -f joshu-stack"
