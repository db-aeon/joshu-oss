#!/usr/bin/env bash
# Stage joshu-design into .docker-staging/joshu-design for fleet image builds.
# OSS builds leave an empty marker — Dockerfile falls back to vanilla shell theme.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="${ROOT_DIR}/.docker-staging/joshu-design"

resolve_design_pack() {
  if [[ -n "${JOSHU_DESIGN_PACK:-}" && -d "${JOSHU_DESIGN_PACK}/arozos/web-overlays" ]]; then
    echo "${JOSHU_DESIGN_PACK}"
    return 0
  fi
  for candidate in \
    "${ROOT_DIR}/joshu-design" \
    "${ROOT_DIR}/../joshu-design"; do
    if [[ -d "${candidate}/arozos/web-overlays" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

should_stage_branding() {
  # Explicit opt-out for vanilla-only builds from the fleet repo.
  if [[ "${JOSHU_DESIGN_PACK_SKIP:-}" =~ ^(1|true|yes)$ ]]; then
    return 1
  fi
  # Explicit design pack path always stages when present.
  if [[ -n "${JOSHU_DESIGN_PACK:-}" ]]; then
    return 0
  fi
  # Fleet sandbox channel (local build or CI).
  local repo="${JOSHU_IMAGE_REPO:-}"
  local ref="${JOSHU_IMAGE_REF:-}"
  if [[ "${repo}" == *joshu-sandbox* || "${ref}" == *joshu-sandbox* ]]; then
    return 0
  fi
  # Checked-out design pack next to CI workspace (joshu-design/).
  if [[ -d "${ROOT_DIR}/joshu-design/arozos/web-overlays" ]]; then
    return 0
  fi
  return 1
}

rm -rf "${STAGING}"
mkdir -p "${STAGING}"

if should_stage_branding && pack="$(resolve_design_pack)"; then
  rsync -a --exclude .git "${pack}/" "${STAGING}/"
  # Icon / desktop glyph assets live in the fleet repo (not always in joshu-design).
  for sub in icons desktop-icons; do
    if [[ -d "${ROOT_DIR}/arozos/${sub}" ]]; then
      mkdir -p "${STAGING}/arozos/${sub}"
      rsync -a "${ROOT_DIR}/arozos/${sub}/" "${STAGING}/arozos/${sub}/"
    fi
  done
  # init-black.jpg ships in fleet web-overlays when absent from the design pack.
  if [[ ! -f "${STAGING}/arozos/web-overlays/init-black.jpg" \
    && -f "${ROOT_DIR}/arozos/web-overlays/init-black.jpg" ]]; then
    cp "${ROOT_DIR}/arozos/web-overlays/init-black.jpg" "${STAGING}/arozos/web-overlays/"
  fi
  echo "[stage-docker-design-pack] staged branded pack from ${pack}"
else
  touch "${STAGING}/.no-design-pack"
  echo "[stage-docker-design-pack] no branded pack — image will use vanilla shell theme"
fi
