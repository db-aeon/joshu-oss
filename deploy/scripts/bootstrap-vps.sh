#!/usr/bin/env bash
# Cloud-init / first-boot script for a fresh VPS.
set -euo pipefail

JOSHU_REPO="${JOSHU_REPO:-https://github.com/db-aeon/joshu-oss.git}"
JOSHU_REF="${JOSHU_REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/joshu}"
ENV_FILE="${ENV_FILE:-/etc/joshu/instance.env}"

# DigitalOcean (and some Hetzner images) run unattended-upgrades on first boot.
apt_retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [[ "${n}" -ge 24 ]]; then
      echo "[bootstrap-vps] apt still locked after ${n} tries" >&2
      return 1
    fi
    echo "[bootstrap-vps] apt busy (try ${n}); waiting 5s"
    sleep 5
  done
}

apt_retry apt-get update
apt_retry apt-get install -y ca-certificates curl git gettext-base

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt_retry apt-get update
apt_retry apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

mkdir -p /etc/joshu
chmod 700 /etc/joshu

if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  git clone --depth 1 --branch "${JOSHU_REF}" "${JOSHU_REPO}" "${INSTALL_DIR}"
fi
# Compose always binds this overlay; empty = use image-baked boot scripts.
mkdir -p "${INSTALL_DIR}/hotfix/scripts"

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${INSTALL_DIR}/deploy/.env.vps.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "[bootstrap-vps] created ${ENV_FILE} from template"
fi

bash "${INSTALL_DIR}/deploy/scripts/ensure-instance-env-secrets.sh" "${ENV_FILE}"

cd "${INSTALL_DIR}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Pull prebuilt image (OSS default) or build on host when JOSHU_BUILD_IMAGE=1
IMAGE_REF="${JOSHU_IMAGE_REF:-ghcr.io/db-aeon/joshu-oss:latest}"
if [[ "${JOSHU_BUILD_IMAGE:-0}" == "1" ]]; then
  echo "[bootstrap-vps] building ${IMAGE_REF} from Dockerfile"
  docker build -f deploy/Dockerfile -t "${IMAGE_REF}" .
else
  echo "[bootstrap-vps] pulling ${IMAGE_REF}"
  docker pull "${IMAGE_REF}"
fi

# Caddy site — render from instance.env (main site + optional Hermes admin vhost)
bash deploy/scripts/render-caddyfile.sh "${ENV_FILE}"

# Fleet profile starts instance-agent (CP heartbeats). Required when CONTROL_PLANE_URL
# / INSTANCE_AGENT_TOKEN are set; harmless to include for managed sandboxes.
PROFILES=""
if [[ -n "${CONTROL_PLANE_URL:-}" && -n "${INSTANCE_AGENT_TOKEN:-}" ]]; then
  PROFILES="fleet"
fi
case "${JOSHU_VOICE_MODE:-legacy}" in
  realtime) PROFILES="${PROFILES:+$PROFILES,}voice" ;;
  realtime_s2s)
    if [ "${JOSHU_WEB_VOICE_ENABLED:-true}" = "true" ]; then
      PROFILES="${PROFILES:+$PROFILES,}voice-rt,voice"
    else
      PROFILES="${PROFILES:+$PROFILES,}voice-rt"
    fi
    ;;
  *)
    if [ "${JOSHU_WEB_VOICE_ENABLED:-false}" = "true" ]; then
      PROFILES="${PROFILES:+$PROFILES,}voice"
    fi
    ;;
esac
if [[ -n "${PROFILES}" ]]; then
  export COMPOSE_PROFILES="${PROFILES}"
else
  unset COMPOSE_PROFILES 2>/dev/null || true
fi

# Host compose bind-mounts gitignored trees over the image (dist/, last30days-skill/).
# git clone leaves those dirs empty and shadows the baked copies.
LAST30DAYS_ENGINE="${INSTALL_DIR}/integrations/last30days-skill/skills/last30days/scripts/last30days.py"
if [[ ! -f "${INSTALL_DIR}/dist/server.js" || ! -f "${LAST30DAYS_ENGINE}" ]]; then
  echo "[bootstrap-vps] syncing dist/ + last30days-skill from ${JOSHU_IMAGE_REF:-image}"
  JOSHU_IMAGE_REF="${JOSHU_IMAGE_REF:?JOSHU_IMAGE_REF required}" \
    JOSHU_RELEASE_VERSION="${JOSHU_RELEASE_VERSION:-}" \
    bash "${INSTALL_DIR}/scripts/sync-dist-from-image.sh"
fi

docker compose -f deploy/docker-compose.yml --env-file "${ENV_FILE}" up -d

echo "[bootstrap-vps] stack started for ${CUSTOMER_DOMAIN:-unknown}"
