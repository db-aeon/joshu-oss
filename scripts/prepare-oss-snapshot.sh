#!/usr/bin/env bash
# Copy a clean OSS tree for fresh git init (v1.0.0-oss). Does NOT scrub monorepo history.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/../joshu-oss}"

echo "[prepare-oss-snapshot] source: ${ROOT_DIR}"
echo "[prepare-oss-snapshot] output: ${OUT_DIR}"

mkdir -p "${OUT_DIR}"

# Preserve an existing git checkout (e.g. joshu-oss clone) when refreshing the tree.
RSYNC_DELETE=()
if [[ -d "${OUT_DIR}/.git" ]]; then
  echo "[prepare-oss-snapshot] preserving ${OUT_DIR}/.git"
  RSYNC_DELETE=(--delete)
else
  rm -rf "${OUT_DIR}"
  mkdir -p "${OUT_DIR}"
fi

rsync -a "${RSYNC_DELETE[@]}" \
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
  --exclude .cursor \
  --exclude 'arozos/web-overlays' \
  --exclude .git \
  --exclude 'docs/Joshu-SOP' \
  --exclude 'docs/design/brand-guidelines.md' \
  --exclude 'docs/design/joshu-style-guide-v1.png' \
  --exclude 'docs/first-provisioning-notes.md' \
  --exclude 'docs/troubleshooting-and-lessons.md' \
  --exclude 'docs/session-2026-06-11-learning-browser-sync.md' \
  --exclude 'docs/hotpatch-running-box.md' \
  --exclude 'docs/provider-choices.md' \
  --exclude 'docs/voice-think-speak.md' \
  --exclude 'docs/voice-realtime.md' \
  --exclude 'docs/web-voice.md' \
  --exclude 'docs/phone-voice-local-test.md' \
  --exclude 'docs/joshu-identity.md' \
  --exclude 'docs/day0-cold-start.md' \
  --exclude 'docs/box-state.md' \
  --exclude 'docs/box-state.oss.md' \
  --exclude 'docs/hermes-customizations.md' \
  --exclude 'docs/README.oss.md' \
  --exclude 'docs/design/README.oss.md' \
  "${ROOT_DIR}/" "${OUT_DIR}/"

# Public doc indexes (curated for joshu-oss).
cp "${ROOT_DIR}/README.oss.md" "${OUT_DIR}/README.md"
cp "${ROOT_DIR}/CONTRIBUTING.oss.md" "${OUT_DIR}/CONTRIBUTING.md"
cp "${ROOT_DIR}/docs/README.oss.md" "${OUT_DIR}/docs/README.md"
cp "${ROOT_DIR}/docs/design/README.oss.md" "${OUT_DIR}/docs/design/README.md"
cp "${ROOT_DIR}/docs/box-state.oss.md" "${OUT_DIR}/docs/box-state.md"

bash "${ROOT_DIR}/scripts/oss-doc-sanitize.sh" "${OUT_DIR}"

bash "${ROOT_DIR}/scripts/secret-scan.sh" "${OUT_DIR}"

# Remove files excluded from rsync that may linger from older snapshots (--delete does not drop excluded paths).
rm -rf \
  "${OUT_DIR}/docs/Joshu-SOP" \
  "${OUT_DIR}/docs/hermes-customizations.md" \
  "${OUT_DIR}/docs/joshu-identity.md" \
  "${OUT_DIR}/docs/day0-cold-start.md" \
  "${OUT_DIR}/docs/box-state.md" \
  "${OUT_DIR}/docs/design/brand-guidelines.md" \
  "${OUT_DIR}/docs/design/joshu-style-guide-v1.png" \
  "${OUT_DIR}/docs/first-provisioning-notes.md" \
  "${OUT_DIR}/docs/troubleshooting-and-lessons.md" \
  "${OUT_DIR}/docs/session-2026-06-11-learning-browser-sync.md" \
  "${OUT_DIR}/docs/hotpatch-running-box.md" \
  "${OUT_DIR}/docs/provider-choices.md" \
  "${OUT_DIR}/docs/voice-think-speak.md" \
  "${OUT_DIR}/docs/voice-realtime.md" \
  "${OUT_DIR}/docs/web-voice.md" \
  "${OUT_DIR}/docs/phone-voice-local-test.md" \
  "${OUT_DIR}/arozos/web-overlays" \
  "${OUT_DIR}/.cursor" \
  2>/dev/null || true

DOC_COUNT="$(find "${OUT_DIR}/docs" -type f | wc -l | tr -d ' ')"
echo "[prepare-oss-snapshot] docs in OSS tree: ${DOC_COUNT}"

STALE=0
while IFS= read -r pattern; do
  [[ -z "$pattern" || "$pattern" =~ ^# ]] && continue
  if rg -q "$pattern" "${OUT_DIR}/docs" 2>/dev/null; then
    echo "[prepare-oss-snapshot] WARN stale doc pattern still present: $pattern" >&2
    STALE=1
  fi
done <<'PATTERNS'
hermes-customizations\.md
Joshu-SOP/
your-org/joshu
joshu-beige\.vercel\.app
control-plane-portal\.md
apps/control-plane/
PATTERNS

if [[ "$STALE" -eq 1 ]]; then
  echo "[prepare-oss-snapshot] re-run oss-doc-sanitize or fix source docs" >&2
fi

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
