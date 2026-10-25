#!/usr/bin/env bash
# Cloud-init / first-boot script for a fresh VPS. Needs Docker and the sandbox image;
# no git clone (change image-owned-box-runtime) unless JOSHU_BUILD_IMAGE=1.
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
APT_EXTRA=""
if [[ "${JOSHU_BUILD_IMAGE:-0}" == "1" ]]; then
  APT_EXTRA="git"
fi
# shellcheck disable=SC2086
apt_retry apt-get install -y ca-certificates curl gettext-base ${APT_EXTRA}

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt_retry apt-get update
apt_retry apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

mkdir -p /etc/joshu
# 711: other users can pass through to /etc/joshu/secrets (Hindsight runs as user hindsight)
# but cannot list the directory. instance.env stays 600.
chmod 711 /etc/joshu

# The sandbox image is the only source of code (change image-owned-box-runtime).
# The host gets the host bundle from the image, not a git clone.
if [[ -z "${JOSHU_IMAGE_REF:-}" && -f "${ENV_FILE}" ]]; then
  JOSHU_IMAGE_REF="$(sed -n 's/^JOSHU_IMAGE_REF=//p' "${ENV_FILE}" | tail -1 | tr -d '"')"
fi
IMAGE_REF="${JOSHU_IMAGE_REF:-ghcr.io/db-aeon/joshu-oss:latest}"
if [[ "${JOSHU_BUILD_IMAGE:-0}" == "1" ]]; then
  # Build from source: the clone is only a build context, outside the install directory.
  SRC_DIR="${JOSHU_SRC_DIR:-/opt/joshu-src}"
  if [[ ! -d "${SRC_DIR}/.git" ]]; then
    git clone --depth 1 --branch "${JOSHU_REF}" "${JOSHU_REPO}" "${SRC_DIR}"
  fi
  echo "[bootstrap-vps] building ${IMAGE_REF} from ${SRC_DIR}/deploy/Dockerfile"
  docker build -f "${SRC_DIR}/deploy/Dockerfile" -t "${IMAGE_REF}" "${SRC_DIR}"
else
  echo "[bootstrap-vps] pulling ${IMAGE_REF}"
  docker pull "${IMAGE_REF}"
fi

docker run --rm --entrypoint cat "${IMAGE_REF}" /opt/joshu/.image/host/deploy/scripts/install-host-bundle.sh \
  | JOSHU_IMAGE_REF="${IMAGE_REF}" JOSHU_INSTALL_DIR="${INSTALL_DIR}" JOSHU_SKIP_PULL=1 bash -s

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${INSTALL_DIR}/deploy/.env.vps.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "[bootstrap-vps] created ${ENV_FILE} from template"
fi

bash "${INSTALL_DIR}/deploy/scripts/ensure-instance-env-secrets.sh" "${ENV_FILE}"

cd "${INSTALL_DIR}"
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a
export JOSHU_IMAGE_REF="${IMAGE_REF}"

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

docker compose -f deploy/docker-compose.yml --env-file "${ENV_FILE}" up -d

echo "[bootstrap-vps] stack started for ${CUSTOMER_DOMAIN:-unknown}"
