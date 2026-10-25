#!/usr/bin/env bash
# LEGACY: only for boxes that still have a host checkout (before change image-owned-box-runtime).
# On a box with the host bundle, compose mounts no host code; upgrade with scripts/upgrade-fleet-box-image.sh.
# Sync host bind-mounted dist/ from a Joshu sandbox image (same logic as instance-agent).
# Usage: JOSHU_IMAGE_REF=ghcr.io/.../joshu-sandbox:0.1.17 bash scripts/sync-dist-from-image.sh
set -euo pipefail

INSTALL_DIR="${JOSHU_INSTALL_DIR:-/opt/joshu}"
ENV_FILE="${JOSHU_INSTANCE_ENV:-/etc/joshu/instance.env}"

if [[ -z "${JOSHU_IMAGE_REF:-}" && -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

IMAGE_REF="${JOSHU_IMAGE_REF:?Set JOSHU_IMAGE_REF or define it in ${ENV_FILE}}"
VERSION="${JOSHU_RELEASE_VERSION:-$(echo "$IMAGE_REF" | awk -F: '{print $NF}')}"
DIST_DIR="${INSTALL_DIR}/dist"
APP_SDK_DIST="${INSTALL_DIR}/packages/app-sdk/dist"
BOX_STATE_DIST="${INSTALL_DIR}/packages/box-state/dist"
EMAIL_SIG_DIST="${INSTALL_DIR}/packages/email-signature/dist"
WHITEBOARD_CWM_DIST="${INSTALL_DIR}/packages/whiteboard-cwm/dist"
PROVENANCE="${DIST_DIR}/.release-provenance.json"

mkdir -p "$DIST_DIR" "$APP_SDK_DIST" "$BOX_STATE_DIST" "$EMAIL_SIG_DIST" "$WHITEBOARD_CWM_DIST"

echo "[sync-dist-from-image] pulling ${IMAGE_REF}"
docker pull "$IMAGE_REF"

CID="$(docker create "$IMAGE_REF")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

echo "[sync-dist-from-image] copying dist -> ${DIST_DIR}"
docker cp "${CID}:/opt/joshu/dist/." "$DIST_DIR/"

# 0.1.41 image: Vite `build:excalidraw` emptied tsc's `dist/excalidraw/*.js` (CWM API).
if [[ ! -f "${DIST_DIR}/excalidraw/errors.js" && -f "${INSTALL_DIR}/deploy/hotfixes/cwm-backend-js/errors.js" ]]; then
  mkdir -p "${DIST_DIR}/excalidraw"
  cp -a "${INSTALL_DIR}/deploy/hotfixes/cwm-backend-js/." "${DIST_DIR}/excalidraw/"
  echo "[sync-dist-from-image] restored CWM backend JS into dist/excalidraw (0.1.41 image hotfix)"
fi

if docker cp "${CID}:/opt/joshu/packages/app-sdk/dist/." "$APP_SDK_DIST/" 2>/dev/null; then
  echo "[sync-dist-from-image] app-sdk dist synced"
else
  echo "[sync-dist-from-image] app-sdk dist not in image (skipped)"
fi

if docker cp "${CID}:/opt/joshu/packages/box-state/dist/." "$BOX_STATE_DIST/" 2>/dev/null; then
  echo "[sync-dist-from-image] box-state dist synced"
else
  echo "[sync-dist-from-image] box-state dist not in image (skipped)"
fi

if docker cp "${CID}:/opt/joshu/packages/email-signature/dist/." "$EMAIL_SIG_DIST/" 2>/dev/null; then
  echo "[sync-dist-from-image] email-signature dist synced"
else
  echo "[sync-dist-from-image] email-signature dist not in image (skipped)"
fi

if docker cp "${CID}:/opt/joshu/packages/whiteboard-cwm/dist/." "$WHITEBOARD_CWM_DIST/" 2>/dev/null; then
  echo "[sync-dist-from-image] whiteboard-cwm dist synced"
else
  echo "[sync-dist-from-image] whiteboard-cwm dist not in image (skipped)"
fi

# Gitignored engine snapshot — compose bind-mounts host path over the image copy.
# Fresh git clone leaves an empty dir and last30days research 400s "engine missing".
SKILL_DIR="${INSTALL_DIR}/integrations/last30days-skill"
mkdir -p "$SKILL_DIR"
if docker cp "${CID}:/opt/joshu/integrations/last30days-skill/." "$SKILL_DIR/" 2>/dev/null \
  && [[ -f "${SKILL_DIR}/skills/last30days/scripts/last30days.py" ]]; then
  echo "[sync-dist-from-image] last30days-skill synced"
else
  echo "[sync-dist-from-image] last30days-skill not in image (skipped)"
fi

GIT_REF=""
if command -v git >/dev/null 2>&1 && [ -d "${INSTALL_DIR}/.git" ]; then
  GIT_REF="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
fi

DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE_REF" 2>/dev/null || true)"
SYNCED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$PROVENANCE" <<EOF
{
  "version": "${VERSION}",
  "imageRef": "${IMAGE_REF}",
  "imageDigest": "${DIGEST}",
  "distSource": "image-sync",
  "syncedAt": "${SYNCED_AT}",
  "gitRef": "${GIT_REF}"
}
EOF

echo "[sync-dist-from-image] wrote ${PROVENANCE} (version=${VERSION})"
echo "[sync-dist-from-image] recreate joshu-stack to pick up dist mount:"
echo "  cd ${INSTALL_DIR}/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack"
