#!/usr/bin/env bash
# Copy a clean OSS tree for fresh git init (v1.0.0-oss). Does NOT scrub monorepo history.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/../joshu-oss}"

echo "[prepare-oss-snapshot] source: ${ROOT_DIR}"
echo "[prepare-oss-snapshot] output: ${OUT_DIR}"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

rsync -a \
  --exclude .git \
  --exclude node_modules \
  --exclude .next \
  --exclude dist \
  --exclude .local \
  --exclude apps/control-plane \
  --exclude .env \
  --exclude .env.local \
  --exclude '**/.env' \
  --exclude '**/.env.local' \
  --exclude '**/.env.*.local' \
  --exclude aeon-page-to-speech-config.json \
  --exclude proprietary \
  --exclude vendor \
  --exclude 'docs/Joshu-SOP' \
  --exclude 'docs/design/brand-guidelines.md' \
  --exclude 'docs/design/joshu-style-guide-v1.png' \
  --exclude 'docs/vps-sandbox/first-provisioning-notes.md' \
  --exclude 'docs/vps-sandbox/troubleshooting-and-lessons.md' \
  --exclude 'docs/vps-sandbox/session-2026-06-11-learning-browser-sync.md' \
  --exclude 'docs/vps-sandbox/hotpatch-running-box.md' \
  --exclude 'docs/vps-sandbox/provider-choices.md' \
  --exclude 'docs/vps-sandbox/voice-think-speak.md' \
  --exclude 'docs/vps-sandbox/voice-realtime.md' \
  --exclude 'docs/vps-sandbox/web-voice.md' \
  --exclude 'docs/vps-sandbox/phone-voice-local-test.md' \
  --exclude 'docs/joshu-identity.md' \
  --exclude 'docs/day0-cold-start.md' \
  --exclude 'docs/box-state.md' \
  --exclude 'docs/hermes-customizations.md' \
  --exclude 'docs/README.oss.md' \
  --exclude 'docs/vps-sandbox/README.oss.md' \
  --exclude 'docs/design/README.oss.md' \
  "${ROOT_DIR}/" "${OUT_DIR}/"

# Public doc indexes (curated for joshu-oss).
cp "${ROOT_DIR}/docs/README.oss.md" "${OUT_DIR}/docs/README.md"
cp "${ROOT_DIR}/docs/vps-sandbox/README.oss.md" "${OUT_DIR}/docs/vps-sandbox/README.md"
cp "${ROOT_DIR}/docs/design/README.oss.md" "${OUT_DIR}/docs/design/README.md"

bash "${ROOT_DIR}/scripts/secret-scan.sh" "${OUT_DIR}"

DOC_COUNT="$(find "${OUT_DIR}/docs" -type f | wc -l | tr -d ' ')"
echo "[prepare-oss-snapshot] docs in OSS tree: ${DOC_COUNT}"

cat <<EOF

[prepare-oss-snapshot] clean tree ready at ${OUT_DIR}

Next steps:
  cd ${OUT_DIR}
  git add -A
  git commit -m "Curate public docs for OSS snapshot"
  git push origin main

Private docs remain in ${ROOT_DIR}/docs/ (Joshu-SOP, fleet runbooks, brand book).
Control plane docs: joshu-control-plane/docs/

EOF
