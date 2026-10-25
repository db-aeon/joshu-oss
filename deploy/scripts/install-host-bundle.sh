#!/usr/bin/env bash
# Write the host bundle of a release to the host (change image-owned-box-runtime).
#
# The host bundle is in the sandbox image at /opt/joshu/.image/host/. This script
# copies it to ${JOSHU_INSTALL_DIR}/deploy/, keeps a backup of the earlier deploy/,
# empties the hotfix overlay (each upgrade does), and records the release in .host-bundle.json.
#
# The script needs only Docker and the image reference. On a host without this file,
# read it from the image:
#   docker run --rm --entrypoint cat "$IMAGE" /opt/joshu/.image/host/deploy/scripts/install-host-bundle.sh \
#     | JOSHU_IMAGE_REF="$IMAGE" bash -s
#
# Environment:
#   JOSHU_IMAGE_REF        sandbox image of the release (required)
#   JOSHU_RELEASE_VERSION  release version (default: the tag of JOSHU_IMAGE_REF)
#   JOSHU_INSTALL_DIR      install directory on the host (default: /opt/joshu)
#   JOSHU_SKIP_PULL=1      use the local image, do not pull
#   JOSHU_CONFIG_DIR       host configuration directory (default: /etc/joshu)
set -euo pipefail

IMAGE_REF="${JOSHU_IMAGE_REF:?Set JOSHU_IMAGE_REF to the sandbox image of the release}"
VERSION="${JOSHU_RELEASE_VERSION:-${IMAGE_REF##*:}}"
INSTALL_DIR="${JOSHU_INSTALL_DIR:-/opt/joshu}"
CONFIG_DIR="${JOSHU_CONFIG_DIR:-/etc/joshu}"
DEPLOY_DIR="${INSTALL_DIR}/deploy"
BACKUP_ROOT="${INSTALL_DIR}/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log() { echo "[install-host-bundle] $*"; }

if [[ "${JOSHU_SKIP_PULL:-0}" != "1" ]]; then
  log "pulling ${IMAGE_REF}"
  docker pull -q "${IMAGE_REF}" >/dev/null
fi

STAGE="$(mktemp -d)"
CID="$(docker create "${IMAGE_REF}")"
cleanup() {
  docker rm -f "${CID}" >/dev/null 2>&1 || true
  rm -rf "${STAGE}"
}
trap cleanup EXIT

docker cp "${CID}:/opt/joshu/.image/host/." "${STAGE}/"
if [[ ! -f "${STAGE}/deploy/docker-compose.yml" ]]; then
  echo "[install-host-bundle] ${IMAGE_REF} has no host bundle (/opt/joshu/.image/host/deploy/docker-compose.yml)" >&2
  exit 1
fi

if [[ -d "${DEPLOY_DIR}" ]]; then
  mkdir -p "${BACKUP_ROOT}"
  cp -a "${DEPLOY_DIR}" "${BACKUP_ROOT}/deploy-${STAMP}"
  log "backup of ${DEPLOY_DIR} -> ${BACKUP_ROOT}/deploy-${STAMP}"
fi

mkdir -p "${DEPLOY_DIR}/scripts" "${INSTALL_DIR}/hotfix/scripts"
# Each upgrade empties the hotfix overlay: a hotfix lives until the next release.
if find "${INSTALL_DIR}/hotfix/scripts" -mindepth 1 ! -name '.gitkeep' -print -quit | grep -q .; then
  log "empty hotfix overlay ${INSTALL_DIR}/hotfix/scripts"
  find "${INSTALL_DIR}/hotfix/scripts" -mindepth 1 ! -name '.gitkeep' -exec rm -rf {} + 2>/dev/null || true
fi
(cd "${STAGE}" && find . -type f) | while IFS= read -r rel; do
  rel="${rel#./}"
  mkdir -p "$(dirname "${INSTALL_DIR}/${rel}")"
  cp "${STAGE}/${rel}" "${INSTALL_DIR}/${rel}"
  if [[ "${rel}" == *.sh ]]; then chmod 0755 "${INSTALL_DIR}/${rel}"; else chmod 0644 "${INSTALL_DIR}/${rel}"; fi
  log "wrote ${INSTALL_DIR}/${rel}"
done

DIGEST="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "${IMAGE_REF}" 2>/dev/null || true)"
cat > "${DEPLOY_DIR}/.host-bundle.json" <<JSON
{
  "version": "${VERSION}",
  "imageRef": "${IMAGE_REF}",
  "imageDigest": "${DIGEST}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
log "wrote ${DEPLOY_DIR}/.host-bundle.json (version ${VERSION})"

# Compose mounts the whole configuration directory into the stack container. Service
# users there (Hindsight runs as user hindsight) must be able to pass through it to read
# /etc/joshu/secrets/*. Mode 700 blocks them (box clara, 2026-10-08). Add only the
# execute bits: the files keep their own modes (instance.env stays 600).
if [[ -d "${CONFIG_DIR}" && "$(stat -c %a "${CONFIG_DIR}" 2>/dev/null)" == 700 ]]; then
  chmod 711 "${CONFIG_DIR}"
  log "set ${CONFIG_DIR} to 711 so service users can reach ${CONFIG_DIR}/secrets"
fi
