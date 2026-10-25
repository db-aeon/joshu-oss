#!/usr/bin/env bash
# Create or start the local shared Chromium container (CDP + Decodo).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAMOFOX_CONTAINER="${CAMOFOX_CONTAINER:-camofox-hitl}"
CAMOFOX_URL="${CAMOFOX_URL:-http://127.0.0.1:9377}"
CHROMIUM_IMAGE="${CHROMIUM_IMAGE:-joshu-chromium-cdp:local}"

load_root_env() {
  if [[ -f "${ROOT_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${ROOT_DIR}/.env"
    set +a
  fi
}

proxy_configured() {
  [[ -n "${PROXY_HOST:-}" || -n "${PROXY_BACKCONNECT_HOST:-}" ]]
}

camofox_proxy_env_args() {
  local key
  for key in PROXY_STRATEGY PROXY_PROVIDER PROXY_HOST PROXY_PORT PROXY_PORTS \
    PROXY_USERNAME PROXY_PASSWORD PROXY_BACKCONNECT_HOST PROXY_BACKCONNECT_PORT \
    PROXY_COUNTRY PROXY_STATE PROXY_CITY PROXY_ZIP PROXY_SESSION_DURATION_MINUTES; do
    if [[ -n "${!key:-}" ]]; then
      printf '%s\0%s\0' -e "${key}=${!key}"
    fi
  done
}

container_image() {
  docker inspect "${CAMOFOX_CONTAINER}" --format '{{.Config.Image}}' 2>/dev/null || true
}

container_has_proxy_env() {
  docker inspect "${CAMOFOX_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -qE '^PROXY_(HOST|BACKCONNECT_HOST)='
}

load_root_env

if curl -fsS "${CAMOFOX_URL}/health" >/dev/null 2>&1; then
  if proxy_configured && docker ps -a --format '{{.Names}}' | grep -qx "${CAMOFOX_CONTAINER}" && ! container_has_proxy_env; then
    echo "[ensure-chromium] recreating ${CAMOFOX_CONTAINER} — PROXY_* in .env but container lacks proxy env"
    docker rm -f "${CAMOFOX_CONTAINER}" >/dev/null
  elif docker ps -a --format '{{.Names}}' | grep -qx "${CAMOFOX_CONTAINER}" \
    && [[ "$(container_image)" != "${CHROMIUM_IMAGE}" ]]; then
    echo "[ensure-chromium] recreating ${CAMOFOX_CONTAINER} — not ${CHROMIUM_IMAGE}"
    docker rm -f "${CAMOFOX_CONTAINER}" >/dev/null
  else
    echo "[ensure-chromium] already healthy at ${CAMOFOX_URL} (container ${CAMOFOX_CONTAINER})"
    exit 0
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ensure-chromium] docker not found in PATH" >&2
  exit 1
fi

echo "[ensure-chromium] building ${CHROMIUM_IMAGE}"
docker build -t "${CHROMIUM_IMAGE}" "${ROOT_DIR}/browser/chromium"

if docker ps -a --format '{{.Names}}' | grep -qx "${CAMOFOX_CONTAINER}"; then
  if [[ "$(container_image)" != "${CHROMIUM_IMAGE}" ]]; then
    echo "[ensure-chromium] removing ${CAMOFOX_CONTAINER} — image is $(container_image)"
    docker rm -f "${CAMOFOX_CONTAINER}" >/dev/null
  fi
fi

PROXY_DOCKER_ARGS=()
if proxy_configured; then
  while IFS= read -r -d '' arg; do
    PROXY_DOCKER_ARGS+=("${arg}")
  done < <(camofox_proxy_env_args)
  echo "[ensure-chromium] proxy enabled (${PROXY_HOST:-${PROXY_BACKCONNECT_HOST}})"
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${CAMOFOX_CONTAINER}"; then
  echo "[ensure-chromium] starting existing container ${CAMOFOX_CONTAINER}"
  docker start "${CAMOFOX_CONTAINER}" >/dev/null
else
  echo "[ensure-chromium] creating container ${CAMOFOX_CONTAINER}"
  docker run -d --name "${CAMOFOX_CONTAINER}" \
    --restart unless-stopped \
    --shm-size=1g \
    -p 127.0.0.1:9377:9377 \
    -p 127.0.0.1:9222:9222 \
    -e VNC_RESOLUTION="${VNC_RESOLUTION:-1024x768}" \
    -e CAMOFOX_VIEWPORT_WIDTH="${CAMOFOX_VIEWPORT_WIDTH:-1024}" \
    -e CAMOFOX_VIEWPORT_HEIGHT="${CAMOFOX_VIEWPORT_HEIGHT:-768}" \
    "${PROXY_DOCKER_ARGS[@]}" \
    "${CHROMIUM_IMAGE}" >/dev/null
fi

deadline=$((SECONDS + 90))
until curl -fsS "${CAMOFOX_URL}/health" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "[ensure-chromium] timed out waiting for ${CAMOFOX_URL}/health" >&2
    docker logs "${CAMOFOX_CONTAINER}" 2>&1 | tail -40 >&2 || true
    exit 1
  fi
  sleep 1
done

echo "[ensure-chromium] ready at ${CAMOFOX_URL} (CDP http://127.0.0.1:9222)"
