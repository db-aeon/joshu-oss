#!/usr/bin/env bash
# Build the VPS sandbox image with HERMES_AGENT_REF from deploy/RELEASE.json.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

node scripts/sync-vps-hermes-pin.mjs
HERMES_AGENT_REF="$(node scripts/sync-vps-hermes-pin.mjs --print)"
GBRAIN_REF="$(node -e "console.log(JSON.parse(require('fs').readFileSync('deploy/RELEASE.json','utf8')).gbrainRef)")"

IMAGE_TAG="${JOSHU_IMAGE_TAG:-local}"
IMAGE_REPO="${JOSHU_IMAGE_REPO:-ghcr.io/${GITHUB_REPOSITORY_OWNER:-your-org}/joshu-oss}"
IMAGE_REF="${JOSHU_IMAGE_REF:-${IMAGE_REPO}:${IMAGE_TAG}}"
VOICE_IMAGE_REPO="${JOSHU_VOICE_IMAGE_REPO:-ghcr.io/${GITHUB_REPOSITORY_OWNER:-your-org}/joshu-voice-realtime}"
VOICE_IMAGE_REF="${JOSHU_VOICE_IMAGE_REF:-${VOICE_IMAGE_REPO}:${IMAGE_TAG}}"
PUSH="${JOSHU_IMAGE_PUSH:-0}"

echo "[vps-build] HERMES_AGENT_REF=${HERMES_AGENT_REF}"
echo "[vps-build] GBRAIN_REF=${GBRAIN_REF}"
echo "[vps-build] sandbox=${IMAGE_REF}"
echo "[vps-build] voice-realtime=${VOICE_IMAGE_REF} push=${PUSH}"

SANDBOX_BUILD_ARGS=(
  --platform linux/amd64
  -f deploy/Dockerfile
  --build-arg "HERMES_AGENT_REF=${HERMES_AGENT_REF}"
  --build-arg "GBRAIN_REF=${GBRAIN_REF}"
  -t "${IMAGE_REF}"
)

VOICE_BUILD_ARGS=(
  --platform linux/amd64
  -f deploy/Dockerfile.voice-realtime
  -t "${VOICE_IMAGE_REF}"
)

if [[ "${PUSH}" == "1" ]]; then
  docker buildx build "${SANDBOX_BUILD_ARGS[@]}" --push .
  docker buildx build "${VOICE_BUILD_ARGS[@]}" --push .
else
  docker buildx build "${SANDBOX_BUILD_ARGS[@]}" --load .
  docker buildx build "${VOICE_BUILD_ARGS[@]}" --load .
fi

echo "[vps-build] done: ${IMAGE_REF} + ${VOICE_IMAGE_REF}"
