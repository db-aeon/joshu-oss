#!/usr/bin/env bash
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
BOX_STATE_DIST="${INSTALL_DIR}/packages/box-state/dist"
EMAIL_SIG_DIST="${INSTALL_DIR}/packages/email-signature/dist"
PROVENANCE="${DIST_DIR}/.release-provenance.json"

mkdir -p "$DIST_DIR" "$BOX_STATE_DIST" "$EMAIL_SIG_DIST"

echo "[sync-dist-from-image] pulling ${IMAGE_REF}"
docker pull "$IMAGE_REF"

CID="$(docker create "$IMAGE_REF")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

echo "[sync-dist-from-image] copying dist -> ${DIST_DIR}"
docker cp "${CID}:/opt/joshu/dist/." "$DIST_DIR/"

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
