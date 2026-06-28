#!/usr/bin/env bash
# Install a sideloaded .joshu-app bundle into arozos/subservice and register app skills.
#
# Bundle layout:
#   my-app/
#     joshu.app.json
#     moduleInfo.json
#     start.sh
#     app/              # built static assets
#     skills/           # optional: my-skill/SKILL.md → HERMES_HOME/skills/apps/<id>/
#
# Usage:
#   scripts/install-joshu-app.sh /path/to/bundle-or.zip
#   JOSHU_PROJECT_ROOT=/path/to/joshu scripts/install-joshu-app.sh ./my-app.joshu-app
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-}"
TARGET="${JOSHU_AROZ_SUBSERVICE:-${ROOT_DIR}/arozos/subservice}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
TMP_DIR=""

if [[ -z "${SOURCE}" ]]; then
  echo "Usage: $0 <bundle-dir-or.zip>" >&2
  exit 2
fi

cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

resolve_bundle_root() {
  if [[ -f "${SOURCE}" && "${SOURCE}" == *.zip ]]; then
    TMP_DIR="$(mktemp -d)"
    unzip -q "${SOURCE}" -d "${TMP_DIR}"
    # Use first directory containing joshu.app.json
    local found
    found="$(find "${TMP_DIR}" -name joshu.app.json -print -quit | xargs dirname 2>/dev/null || true)"
    if [[ -z "${found}" ]]; then
      echo "No joshu.app.json in zip: ${SOURCE}" >&2
      exit 1
    fi
    echo "${found}"
    return
  fi
  if [[ -d "${SOURCE}" ]]; then
    echo "${SOURCE}"
    return
  fi
  echo "Not a directory or zip: ${SOURCE}" >&2
  exit 1
}

BUNDLE_ROOT="$(resolve_bundle_root)"
MANIFEST="${BUNDLE_ROOT}/joshu.app.json"
if [[ ! -f "${MANIFEST}" ]]; then
  echo "Missing joshu.app.json in ${BUNDLE_ROOT}" >&2
  exit 1
fi

APP_ID="$(node -e "const m=require('${MANIFEST}'); if(!m.id) process.exit(1); console.log(m.id)")"
echo "[install-joshu-app] installing ${APP_ID} -> ${TARGET}/${APP_ID}"

mkdir -p "${TARGET}/${APP_ID}"
rsync -a --delete "${BUNDLE_ROOT}/" "${TARGET}/${APP_ID}/"
if [[ -f "${TARGET}/${APP_ID}/start.sh" ]]; then
  chmod +x "${TARGET}/${APP_ID}/start.sh"
fi

# Validate manifest via @joshu/app-sdk when built
if [[ -f "${ROOT_DIR}/packages/app-sdk/dist/cli.js" ]]; then
  node "${ROOT_DIR}/packages/app-sdk/dist/cli.js" validate "${TARGET}/${APP_ID}/joshu.app.json"
fi

# Copy bundled skills → HERMES_HOME/skills/apps/<appId>/
if [[ -d "${BUNDLE_ROOT}/skills" ]]; then
  DEST_SKILLS="${HERMES_HOME}/skills/apps/${APP_ID}"
  mkdir -p "${DEST_SKILLS}"
  rsync -a "${BUNDLE_ROOT}/skills/" "${DEST_SKILLS}/"
  echo "[install-joshu-app] skills -> ${DEST_SKILLS}"
fi

# Register app skill names in .joshu/app-skills.json (dev + Aroz user registry)
SKILL_NAME="$(node -e "const m=require('${MANIFEST}'); console.log(m.agent?.skill||'')")"
if [[ -n "${SKILL_NAME}" ]]; then
  node --input-type=module <<NODE
import { registerAppSkill } from "${ROOT_DIR}/dist/appSkillsRegistry.js";
await registerAppSkill("${ROOT_DIR}", "${SKILL_NAME}");
console.log("[install-joshu-app] registered skill ${SKILL_NAME}");
NODE
fi

echo "[install-joshu-app] done"
