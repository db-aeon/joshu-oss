#!/usr/bin/env bash
# Source before fleet image builds (official ghcr.io/.../joshu-sandbox channel).
# Copy to fleet-build-env.local and adjust paths — never commit secrets.
#
#   source scripts/fleet-build-env.example.sh
#   npm run vps:build-image

export JOSHU_DESIGN_PACK="${JOSHU_DESIGN_PACK:-${HOME}/Documents/dev/joshu-design}"
export JOSHU_IMAGE_REPO="${JOSHU_IMAGE_REPO:-ghcr.io/db-aeon/joshu-sandbox}"

echo "[fleet-build-env] JOSHU_DESIGN_PACK=${JOSHU_DESIGN_PACK}"
echo "[fleet-build-env] JOSHU_IMAGE_REPO=${JOSHU_IMAGE_REPO}"

bash "$(dirname "$0")/install-proprietary-apps.sh"
