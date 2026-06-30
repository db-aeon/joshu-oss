#!/usr/bin/env bash
# Reset an ArozOS desktop login password from SSH (solo self-host recovery).
#
# Joshu has no email "forgot password" flow. When you are the only user and locked
# out, use this script as root on the VPS. It stops joshu-stack briefly, writes a
# new sha512 passhash into system/ao.db, then starts the stack again.
#
# Usage:
#   bash scripts/arozos-reset-password.sh <username> '<new-password>'
#
# Optional env:
#   AO_DB           — path to ao.db (auto-detected from Docker volume when unset)
#   JOSHU_COMPOSE_DIR — default /opt/joshu/deploy
#   ENV_FILE        — default /etc/joshu/instance.env

set -euo pipefail

USERNAME="${1:?username required}"
NEW_PASSWORD="${2:?new password required}"

JOSHU_COMPOSE_DIR="${JOSHU_COMPOSE_DIR:-/opt/joshu/deploy}"
ENV_FILE="${ENV_FILE:-/etc/joshu/instance.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET_SRC="${SCRIPT_DIR}/arozos-reset-password"
GOLANG_IMAGE="${GOLANG_IMAGE:-golang:1.23-alpine}"

resolve_ao_db() {
  if [[ -n "${AO_DB:-}" && -f "${AO_DB}" ]]; then
    echo "${AO_DB}"
    return
  fi
  local mount
  for vol in deploy_joshu_arozos joshu_arozos; do
    mount="$(docker volume inspect "${vol}" --format '{{ .Mountpoint }}' 2>/dev/null || true)"
    if [[ -n "${mount}" && -f "${mount}/system/ao.db" ]]; then
      echo "${mount}/system/ao.db"
      return
    fi
  done
  echo "[arozos-reset-password] ao.db not found; set AO_DB=/path/to/system/ao.db" >&2
  exit 1
}

list_usernames() {
  local users_root
  users_root="$(dirname "$(dirname "$(dirname "${AO_DB}")")")/files/users"
  if [[ -d "${users_root}" ]]; then
    ls -1 "${users_root}" 2>/dev/null | tr '\n' ' '
  fi
}

AO_DB="$(resolve_ao_db)"
AO_DIR="$(dirname "${AO_DB}")"

if [[ ! -d "${RESET_SRC}" ]]; then
  echo "[arozos-reset-password] missing ${RESET_SRC}" >&2
  exit 1
fi

echo "[arozos-reset-password] db=${AO_DB} user=${USERNAME}"

if [[ -d "${JOSHU_COMPOSE_DIR}" && -f "${ENV_FILE}" ]]; then
  (
    cd "${JOSHU_COMPOSE_DIR}"
    docker compose -f docker-compose.yml --env-file "${ENV_FILE}" stop joshu-stack
  )
  RESTART=1
else
  echo "[arozos-reset-password] WARN: compose dir/env not found; ensure ArozOS is stopped if update fails" >&2
  RESTART=0
fi

cleanup() {
  if [[ "${RESTART:-0}" == 1 ]]; then
    (
      cd "${JOSHU_COMPOSE_DIR}"
      docker compose -f docker-compose.yml --env-file "${ENV_FILE}" start joshu-stack
    ) || true
  fi
}
trap cleanup EXIT

if ! docker run --rm \
  -e AO_USER="${USERNAME}" \
  -e AO_PW="${NEW_PASSWORD}" \
  -v "${AO_DIR}:/dbdir:rw" \
  -v "${RESET_SRC}:/src:ro" \
  -w /src \
  "${GOLANG_IMAGE}" \
  sh -c 'go run . -db /dbdir/ao.db -user "$AO_USER" -password "$AO_PW"'; then
  echo "[arozos-reset-password] failed. Known users:$(list_usernames)" >&2
  exit 1
fi

DOMAIN="$(grep -E '^CUSTOMER_DOMAIN=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)"
if [[ -n "${DOMAIN}" ]]; then
  echo "[arozos-reset-password] done — log in at https://${DOMAIN}/"
else
  echo "[arozos-reset-password] done — log in with the new password"
fi
