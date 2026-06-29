#!/usr/bin/env bash
# Bootstrap a single-node Joshu box for self-hosting (no control plane).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${JOSHU_INSTALL_DIR:-/opt/joshu}"
ENV_FILE="${JOSHU_ENV_FILE:-/etc/joshu/instance.env}"
COMPOSE_FILE="${JOSHU_COMPOSE_FILE:-${ROOT_DIR}/deploy/docker-compose.yml}"

echo "[bootstrap-self-host] Joshu standalone box installer"
echo "[bootstrap-self-host] install dir: ${INSTALL_DIR}"
echo "[bootstrap-self-host] env file: ${ENV_FILE}"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "[bootstrap-self-host] re-run with sudo for system paths" >&2
    exit 1
  fi
}

require_root

mkdir -p "$(dirname "${ENV_FILE}")" /etc/joshu/secrets
chmod 700 /etc/joshu/secrets

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${ROOT_DIR}/deploy/.env.vps.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "[bootstrap-self-host] created ${ENV_FILE} from template"
fi

bash "${ROOT_DIR}/deploy/scripts/ensure-instance-env-secrets.sh" "${ENV_FILE}"

# Standalone: no control plane agent registration (ensure script may already set this)
if ! grep -q '^JOSHU_STANDALONE=' "${ENV_FILE}" 2>/dev/null; then
  echo "JOSHU_STANDALONE=1" >> "${ENV_FILE}"
fi

if [[ ! -d "${INSTALL_DIR}" ]]; then
  echo "[bootstrap-self-host] copying tree to ${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}"
  rsync -a --exclude node_modules --exclude .git --exclude .local \
    "${ROOT_DIR}/" "${INSTALL_DIR}/"
fi

export JOSHU_COMPOSE_ENV_FILE="${ENV_FILE}"
cd "${INSTALL_DIR}"

if [[ -z "${JOSHU_IMAGE_REF:-}" ]]; then
  echo "[bootstrap-self-host] build local image (set JOSHU_IMAGE_REF to skip build)"
  npm run vps:build-image
fi

echo "[bootstrap-self-host] starting stack (no fleet profile — instance agent omitted)"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d

echo "[bootstrap-self-host] done"
echo "[bootstrap-self-host] set CUSTOMER_DOMAIN in ${ENV_FILE} if not already"
echo "[bootstrap-self-host] add OpenRouter in Welcome after first login (standalone)"
echo "[bootstrap-self-host] health: curl -fsS http://127.0.0.1:8788/joshu/api/instance/health"
