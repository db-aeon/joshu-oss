#!/usr/bin/env bash
# Create or start the local Camofox Docker container (patched for Joshu HITL).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAMOFOX_CONTAINER="${CAMOFOX_CONTAINER:-camofox-hitl}"
CAMOFOX_URL="${CAMOFOX_URL:-http://127.0.0.1:9377}"

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

container_has_proxy_env() {
  docker inspect "${CAMOFOX_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -qE '^PROXY_(HOST|BACKCONNECT_HOST)='
}

load_root_env

if curl -fsS "${CAMOFOX_URL}/health" >/dev/null 2>&1; then
  if proxy_configured && docker ps -a --format '{{.Names}}' | grep -qx "${CAMOFOX_CONTAINER}" && ! container_has_proxy_env; then
    echo "[ensure-camofox] recreating ${CAMOFOX_CONTAINER} — PROXY_* in .env but container lacks proxy env"
    docker rm -f "${CAMOFOX_CONTAINER}" >/dev/null
  else
    echo "[ensure-camofox] already healthy at ${CAMOFOX_URL} (container ${CAMOFOX_CONTAINER})"
    exit 0
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ensure-camofox] docker not found in PATH" >&2
  exit 1
fi

PROXY_DOCKER_ARGS=()
if proxy_configured; then
  while IFS= read -r -d '' arg; do
    PROXY_DOCKER_ARGS+=("${arg}")
  done < <(camofox_proxy_env_args)
  echo "[ensure-camofox] proxy enabled (${PROXY_HOST:-${PROXY_BACKCONNECT_HOST}})"
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${CAMOFOX_CONTAINER}"; then
  echo "[ensure-camofox] starting existing container ${CAMOFOX_CONTAINER}"
  docker start "${CAMOFOX_CONTAINER}" >/dev/null
else
  echo "[ensure-camofox] creating container ${CAMOFOX_CONTAINER}"
  docker run -d --name "${CAMOFOX_CONTAINER}" \
    --restart unless-stopped \
    -p 127.0.0.1:9377:9377 \
    -p 127.0.0.1:6080:6080 \
    -e ENABLE_VNC=1 \
    -e VNC_BIND=0.0.0.0 \
    -e VNC_RESOLUTION="${VNC_RESOLUTION:-1024x768}" \
    -e CAMOFOX_VIEWPORT_WIDTH="${CAMOFOX_VIEWPORT_WIDTH:-1024}" \
    -e CAMOFOX_VIEWPORT_HEIGHT="${CAMOFOX_VIEWPORT_HEIGHT:-768}" \
    -e MAX_TABS_PER_SESSION="${MAX_TABS_PER_SESSION:-1}" \
    -e MAX_TABS_GLOBAL="${MAX_TABS_GLOBAL:-1}" \
    -e CAMOFOX_MAX_TABS="${CAMOFOX_MAX_TABS:-1}" \
    -e HITL_FORCE_SINGLE_VISIBLE_PAGE="${HITL_FORCE_SINGLE_VISIBLE_PAGE:-true}" \
    -e CAMOFOX_START_URL="${CAMOFOX_START_URL:-https://news.google.com/}" \
    -e CAMOFOX_FF_VERSION="${CAMOFOX_FF_VERSION:-139}" \
    "${PROXY_DOCKER_ARGS[@]}" \
    -v "${ROOT_DIR}:/opt/joshu:ro" \
    --entrypoint /bin/sh \
    ghcr.io/jo-inc/camofox-browser:latest \
    -lc 'node /opt/joshu/scripts/patch-camofox-single-tab.mjs /app/server.js && cd /app && node server.js' >/dev/null
fi

deadline=$((SECONDS + 90))
until curl -fsS "${CAMOFOX_URL}/health" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "[ensure-camofox] timed out waiting for ${CAMOFOX_URL}/health" >&2
    docker logs "${CAMOFOX_CONTAINER}" 2>&1 | tail -30 >&2 || true
    exit 1
  fi
  sleep 1
done

if proxy_configured; then
  docker logs "${CAMOFOX_CONTAINER}" 2>&1 | grep -iE 'proxy pool|no proxy' | tail -3 || true
fi

echo "[ensure-camofox] ready at ${CAMOFOX_URL}"
