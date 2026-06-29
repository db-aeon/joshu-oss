#!/usr/bin/env bash
# Cloud-init / first-boot script for a fresh Hetzner (or other) VPS.
set -euo pipefail

JOSHU_REPO="${JOSHU_REPO:-https://github.com/your-org/joshu.git}"
JOSHU_REF="${JOSHU_REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/joshu}"
ENV_FILE="${ENV_FILE:-/etc/joshu/instance.env}"

apt-get update
apt-get install -y ca-certificates curl git gettext-base

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

mkdir -p /etc/joshu
chmod 700 /etc/joshu

if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  git clone --depth 1 --branch "${JOSHU_REF}" "${JOSHU_REPO}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Pull prebuilt image (OSS default) or build on host when JOSHU_BUILD_IMAGE=1
IMAGE_REF="${JOSHU_IMAGE_REF:-ghcr.io/your-org/joshu-oss:latest}"
if [[ "${JOSHU_BUILD_IMAGE:-0}" == "1" ]]; then
  echo "[bootstrap-vps] building ${IMAGE_REF} from Dockerfile"
  docker build -f deploy/Dockerfile -t "${IMAGE_REF}" .
else
  echo "[bootstrap-vps] pulling ${IMAGE_REF}"
  docker pull "${IMAGE_REF}"
fi

# Caddy site — render from instance.env (main site + optional Hermes admin vhost)
bash deploy/scripts/render-caddyfile.sh "${ENV_FILE}"

case "${JOSHU_VOICE_MODE:-legacy}" in
  realtime) export COMPOSE_PROFILES=voice ;;
  realtime_s2s)
    if [ "${JOSHU_WEB_VOICE_ENABLED:-true}" = "true" ]; then
      export COMPOSE_PROFILES=voice-rt,voice
    else
      export COMPOSE_PROFILES=voice-rt
    fi
    ;;
  *)
    if [ "${JOSHU_WEB_VOICE_ENABLED:-false}" = "true" ]; then
      export COMPOSE_PROFILES=voice
    else
      unset COMPOSE_PROFILES 2>/dev/null || true
    fi
    ;;
esac

# Host compose bind-mounts ../dist over the image; git clone leaves dist/ empty.
if [[ ! -f "${INSTALL_DIR}/dist/server.js" ]]; then
  echo "[bootstrap-vps] syncing dist/ from ${JOSHU_IMAGE_REF:-image}"
  JOSHU_IMAGE_REF="${JOSHU_IMAGE_REF:?JOSHU_IMAGE_REF required}" \
    JOSHU_RELEASE_VERSION="${JOSHU_RELEASE_VERSION:-}" \
    bash "${INSTALL_DIR}/scripts/sync-dist-from-image.sh"
fi

docker compose -f deploy/docker-compose.yml --env-file "${ENV_FILE}" up -d

echo "[bootstrap-vps] stack started for ${CUSTOMER_DOMAIN:-unknown}"
