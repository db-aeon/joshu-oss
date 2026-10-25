#!/usr/bin/env bash
# LEGACY: only for boxes that still have a host checkout (before change image-owned-box-runtime).
# On a box with the host bundle, compose mounts no host code; upgrade with scripts/upgrade-fleet-box-image.sh.
# Sync host bind-mounted factory Hermes skills (+ factory manifest) from a Joshu sandbox image.
# Host ../integrations/hermes/skills shadows the image in compose — git pull does not refresh it
# on fleet boxes. Merge (no --delete) preserves any host-only skill dirs.
#
# After sync, recreate joshu-stack so vps-start runs bootstrap-hermes-learning-skills.sh. The
# skills seed runs when the factory skills change (seed key = content hash of the skills tree).
#
# Usage: JOSHU_IMAGE_REF=ghcr.io/.../joshu-sandbox:0.1.44 bash scripts/sync-skills-from-image.sh
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
SKILLS_DIR="${INSTALL_DIR}/integrations/hermes/skills"
SKILLS_ENABLED="${INSTALL_DIR}/integrations/hermes/skills-enabled.yaml"
FACTORY_MANIFEST="${INSTALL_DIR}/factory/manifest.yaml"
ONBOARDING_PROMPTS="${INSTALL_DIR}/factory/onboarding-prompts.yaml"
PROVENANCE="${SKILLS_DIR}/.skills-sync-provenance.json"

mkdir -p "${SKILLS_DIR}" "${INSTALL_DIR}/factory"

echo "[sync-skills-from-image] pulling ${IMAGE_REF}"
docker pull "$IMAGE_REF"

CID="$(docker create "$IMAGE_REF")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"; docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

echo "[sync-skills-from-image] extracting skills from image"
docker cp "${CID}:/opt/joshu/integrations/hermes/skills/." "${TMP}/skills/"

echo "[sync-skills-from-image] merge -> ${SKILLS_DIR} (no delete)"
if command -v rsync >/dev/null 2>&1; then
  rsync -a "${TMP}/skills/" "${SKILLS_DIR}/"
else
  cp -a "${TMP}/skills/." "${SKILLS_DIR}/"
fi

for rel in \
  "factory/manifest.yaml:${FACTORY_MANIFEST}" \
  "integrations/hermes/skills-enabled.yaml:${SKILLS_ENABLED}" \
  "factory/onboarding-prompts.yaml:${ONBOARDING_PROMPTS}"; do
  src="${rel%%:*}"
  dest="${rel##*:}"
  if docker cp "${CID}:/opt/joshu/${src}" "${dest}" 2>/dev/null; then
    echo "[sync-skills-from-image] copied ${src} -> ${dest}"
  else
    echo "[sync-skills-from-image] ${src} not in image (skipped)"
  fi
done

DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE_REF" 2>/dev/null || true)"
SYNCED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FACTORY_RELEASE=""
if [[ -f "${FACTORY_MANIFEST}" ]]; then
  FACTORY_RELEASE="$(python3 - "${FACTORY_MANIFEST}" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
m = re.search(r'^release:\s*"?([^"\n]+)"?\s*$', text, re.M)
print(m.group(1).strip() if m else "")
PY
)"
fi

cat > "$PROVENANCE" <<EOF
{
  "version": "${VERSION}",
  "imageRef": "${IMAGE_REF}",
  "imageDigest": "${DIGEST}",
  "skillsSource": "image-sync",
  "syncedAt": "${SYNCED_AT}",
  "factoryRelease": "${FACTORY_RELEASE}"
}
EOF

echo "[sync-skills-from-image] wrote ${PROVENANCE} (factoryRelease=${FACTORY_RELEASE:-unknown})"
echo "[sync-skills-from-image] recreate joshu-stack to run skills bootstrap merge:"
echo "  cd ${INSTALL_DIR}/deploy && docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack"
