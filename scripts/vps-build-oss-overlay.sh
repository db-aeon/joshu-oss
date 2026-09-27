#!/usr/bin/env bash
# Overlay OSS release onto a fleet sandbox GHCR tag (same Hermes/Camofox/gbrain pins).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

OVERLAY_BASE="${JOSHU_OVERLAY_BASE:-ghcr.io/db-aeon/joshu-sandbox:0.1.46}"
IMAGE_TAG="${JOSHU_IMAGE_TAG:-local}"
IMAGE_REPO="${JOSHU_IMAGE_REPO:-ghcr.io/db-aeon/joshu-oss}"
IMAGE_REF="${JOSHU_IMAGE_REF:-${IMAGE_REPO}:${IMAGE_TAG}}"
VOICE_IMAGE_REPO="${JOSHU_VOICE_IMAGE_REPO:-ghcr.io/db-aeon/joshu-oss-voice-realtime}"
VOICE_IMAGE_REF="${JOSHU_VOICE_IMAGE_REF:-${VOICE_IMAGE_REPO}:${IMAGE_TAG}}"
PUSH="${JOSHU_IMAGE_PUSH:-0}"

echo "[vps-oss-overlay] base=${OVERLAY_BASE}"
echo "[vps-oss-overlay] sandbox=${IMAGE_REF}"
echo "[vps-oss-overlay] voice=${VOICE_IMAGE_REF} push=${PUSH}"

bash scripts/check-oss-boundaries.sh
node scripts/copy-runtime-assets.mjs --check-source --check

BUILD_ARGS=(
  --platform linux/amd64
  -f deploy/Dockerfile.oss-overlay
  --build-arg "OVERLAY_BASE=${OVERLAY_BASE}"
  -t "${IMAGE_REF}"
)

if [[ "${PUSH}" == "1" ]]; then
  docker buildx build "${BUILD_ARGS[@]}" --push .
  docker buildx build --platform linux/amd64 -f deploy/Dockerfile.voice-realtime \
    --build-arg "IMAGE_SOURCE=https://github.com/db-aeon/joshu-oss" \
    -t "${VOICE_IMAGE_REF}" --push .
else
  docker buildx build "${BUILD_ARGS[@]}" --load .
  docker buildx build --platform linux/amd64 -f deploy/Dockerfile.voice-realtime \
    --build-arg "IMAGE_SOURCE=https://github.com/db-aeon/joshu-oss" \
    -t "${VOICE_IMAGE_REF}" --load .
fi

echo "[vps-oss-overlay] done: ${IMAGE_REF} + ${VOICE_IMAGE_REF}"
