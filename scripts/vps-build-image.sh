#!/usr/bin/env bash
# Build the VPS sandbox image with HERMES_AGENT_REF from deploy/RELEASE.json.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# Fleet repo: stage Hermes skill-evolution patch before image build (matches CI workflow).
if [[ -f "${ROOT_DIR}/proprietary/scripts/stage-fleet-docker-patches.sh" ]]; then
  bash "${ROOT_DIR}/proprietary/scripts/stage-fleet-docker-patches.sh"
fi

# Stage the branded design pack (fleet) or an empty marker (OSS → vanilla shell).
bash "${ROOT_DIR}/scripts/stage-docker-design-pack.sh"

node scripts/sync-vps-hermes-pin.mjs
node scripts/sync-vps-camofox-pin.mjs
HERMES_AGENT_REF="$(node scripts/sync-vps-hermes-pin.mjs --print)"
CAMOFOX_BASE="$(node scripts/sync-vps-camofox-pin.mjs --print)"
GBRAIN_REF="$(node -e "console.log(JSON.parse(require('fs').readFileSync('deploy/RELEASE.json','utf8')).gbrainRef)")"

IMAGE_TAG="${JOSHU_IMAGE_TAG:-local}"
IMAGE_REPO="${JOSHU_IMAGE_REPO:-ghcr.io/${GITHUB_REPOSITORY_OWNER:-your-org}/joshu-oss}"
IMAGE_REF="${JOSHU_IMAGE_REF:-${IMAGE_REPO}:${IMAGE_TAG}}"
VOICE_IMAGE_REPO="${JOSHU_VOICE_IMAGE_REPO:-ghcr.io/${GITHUB_REPOSITORY_OWNER:-your-org}/joshu-oss-voice-realtime}"
VOICE_IMAGE_REF="${JOSHU_VOICE_IMAGE_REF:-${VOICE_IMAGE_REPO}:${IMAGE_TAG}}"
PUSH="${JOSHU_IMAGE_PUSH:-0}"

echo "[vps-build] HERMES_AGENT_REF=${HERMES_AGENT_REF}"
echo "[vps-build] CAMOFOX_BASE=${CAMOFOX_BASE}"
echo "[vps-build] GBRAIN_REF=${GBRAIN_REF}"
echo "[vps-build] sandbox=${IMAGE_REF}"
echo "[vps-build] voice-realtime=${VOICE_IMAGE_REF} push=${PUSH}"

# Fail closed: listed runtime files must exist in source *and* dist/ (npm run build).
node scripts/copy-runtime-assets.mjs --check-source --check

if [[ ! -f dist/excalidraw/errors.js || ! -f dist/excalidraw/service.js ]]; then
  echo "[vps-build] ERROR: dist/excalidraw CWM backend JS missing (Vite emptyOutDir vs tsc)." >&2
  echo "  Run: npm run vps:predeploy  (build:excalidraw must re-run tsc after Vite)" >&2
  exit 1
fi

NETWORK_ARGS=()
if [[ -n "${JOSHU_DOCKER_NETWORK:-}" ]]; then
  NETWORK_ARGS=(--network "${JOSHU_DOCKER_NETWORK}")
fi

# macOS /bin/bash 3.2 + set -u: "${NETWORK_ARGS[@]}" in a literal array is "unbound" when empty.
SANDBOX_BUILD_ARGS=()
if ((${#NETWORK_ARGS[@]} > 0)); then
  SANDBOX_BUILD_ARGS+=("${NETWORK_ARGS[@]}")
fi
SANDBOX_BUILD_ARGS+=(
  --platform linux/amd64
  -f deploy/Dockerfile
  --build-arg "HERMES_AGENT_REF=${HERMES_AGENT_REF}"
  --build-arg "CAMOFOX_BASE=${CAMOFOX_BASE}"
  --build-arg "GBRAIN_REF=${GBRAIN_REF}"
  -t "${IMAGE_REF}"
)

# Fleet joshu-sandbox builds must bake paper-shell (see stage-docker-design-pack.sh).
if [[ "${IMAGE_REPO}" == *joshu-sandbox* || "${IMAGE_REF}" == *joshu-sandbox* || -f "${ROOT_DIR}/proprietary/README.md" ]]; then
  if [[ ! "${JOSHU_DESIGN_PACK_SKIP:-}" =~ ^(1|true|yes)$ ]]; then
    SANDBOX_BUILD_ARGS+=(--build-arg "JOSHU_REQUIRE_DESIGN_PACK=1")
  fi
fi

VOICE_BUILD_ARGS=()
if ((${#NETWORK_ARGS[@]} > 0)); then
  VOICE_BUILD_ARGS+=("${NETWORK_ARGS[@]}")
fi
VOICE_BUILD_ARGS+=(
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
