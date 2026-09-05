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
  --exclude '.joshu/connectors-providers.env' \
  --exclude 'arozos/subservice/md-editor/app' \
  --exclude 'arozos/subservice/connectors/app' \
  --exclude 'arozos/subservice/jterm/app' \
  --exclude 'arozos/subservice/last30days/app' \
  --exclude 'arozos/subservice/excalidraw/app' \
  --exclude 'arozos/subservice/hermes-chat/app' \
  --exclude 'arozos/subservice/hindsight-viewer/app' \
  --exclude 'arozos/subservice/file-brain-viewer/app' \
  --exclude 'arozos/subservice/schedules/app' \
  --exclude 'arozos/subservice/movie-editor/app' \
  --exclude 'arozos/subservice/jmail/app' \
  --exclude 'arozos/subservice/safety-settings/app' \
  --exclude 'arozos/subservice/welcome/app' \
  --exclude 'arozos/subservice/telephone/app' \
  --exclude aeon-page-to-speech-config.json \
  --exclude proprietary \
  --exclude vendor \
  --exclude .cursor \
  --exclude 'arozos/web-overlays' \
  --exclude .git \
  --exclude 'docs/Joshu-SOP' \
  --exclude 'docs/design/brand-guidelines.md' \
  --exclude 'docs/design/joshu-style-guide-v1.png' \
  --exclude 'docs/vps-sandbox/first-provisioning-notes.md' \
  --exclude 'docs/vps-sandbox/troubleshooting-and-lessons.md' \
  --exclude 'docs/vps-sandbox/session-2026-06-11-learning-browser-sync.md' \
  --exclude 'docs/vps-sandbox/session-2026-06-30-fleet-image-0.1.30-patrick.md' \
  --exclude 'docs/vps-sandbox/hotpatch-running-box.md' \
  --exclude 'docs/vps-sandbox/existing-box-image-vs-host.md' \
  --exclude 'scripts/upgrade-fleet-box-image.sh' \
  --exclude 'docs/vps-sandbox/credential-isolation-langfuse-relay.md' \
  --exclude 'docs/vps-sandbox/update-hardening-todo.md' \
  --exclude 'docs/vps-sandbox/control-plane.md' \
  --exclude 'docs/vps-sandbox/twilio-a2p-sms.md' \
  --exclude 'docs/vps-sandbox/provider-choices.md' \
  --exclude 'docs/vps-sandbox/voice-think-speak.md' \
  --exclude 'docs/vps-sandbox/voice-realtime.md' \
  --exclude 'docs/vps-sandbox/web-voice.md' \
  --exclude 'docs/vps-sandbox/phone-voice-local-test.md' \
  --exclude 'docs/releases' \
  --exclude 'docs/joshu-identity.md' \
  --exclude 'docs/day0-cold-start.md' \
  --exclude 'docs/box-state.md' \
  --exclude 'docs/box-state.oss.md' \
  --exclude 'docs/hermes-customizations.md' \
  --exclude 'docs/README.oss.md' \
  --exclude 'docs/vps-sandbox/README.oss.md' \
  --exclude 'docs/design/README.oss.md' \
  --exclude 'scripts/sync-from-oss.sh' \
  --exclude 'scripts/repair-fleet-ea-cron-timezone.sh' \
  --exclude 'scripts/hotfix-box-to-0.1.26.sh' \
  --exclude 'scripts/sync-hermes-to-vps.sh' \
  --exclude 'scripts/sync-hindsight-to-vps.sh' \
  --exclude 'scripts/sync-camofox-proxy-to-vps.sh' \
  --exclude 'scripts/repair-vps-admin-update.sh' \
  --exclude 'scripts/repair-instance-env-drift.sh' \
  --exclude 'scripts/refresh-vps-ghcr-login.sh' \
  --exclude 'scripts/diff-factory-skill-with-learning.sh' \
  --exclude 'scripts/lib/ensure-hermes-learning-git.sh' \
  --exclude '.github/workflows/fleet-sync-check.yml' \
  --exclude '.github/workflows/joshu-sandbox-image.yml' \
  --exclude 'deploy/.env.vps.example.oss' \
  "${ROOT_DIR}/" "${OUT_DIR}/"

# Public doc indexes (curated for joshu-oss).
cp "${ROOT_DIR}/README.oss.md" "${OUT_DIR}/README.md"
cp "${ROOT_DIR}/CONTRIBUTING.oss.md" "${OUT_DIR}/CONTRIBUTING.md"
cp "${ROOT_DIR}/docs/README.oss.md" "${OUT_DIR}/docs/README.md"
cp "${ROOT_DIR}/docs/vps-sandbox/README.oss.md" "${OUT_DIR}/docs/vps-sandbox/README.md"
cp "${ROOT_DIR}/docs/design/README.oss.md" "${OUT_DIR}/docs/design/README.md"
cp "${ROOT_DIR}/docs/box-state.oss.md" "${OUT_DIR}/docs/box-state.md"

# Keys-only self-host env template (no CP relay URLs).
if [[ -f "${ROOT_DIR}/deploy/.env.vps.example.oss" ]]; then
  cp "${ROOT_DIR}/deploy/.env.vps.example.oss" "${OUT_DIR}/deploy/.env.vps.example"
fi

# Rewrite RELEASE.json image refs for public GHCR package names.
if [[ -f "${OUT_DIR}/deploy/RELEASE.json" ]]; then
  python3 - "${OUT_DIR}/deploy/RELEASE.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
ver = data.get("version", "")
if ver:
    data["imageRef"] = f"ghcr.io/db-aeon/joshu-oss:{ver}"
    data["voiceImageRef"] = f"ghcr.io/db-aeon/joshu-oss-voice-realtime:{ver}"
    notes = (data.get("notes") or "").strip()
    if notes.startswith("Fleet "):
        data["notes"] = notes.removeprefix("Fleet ").strip()
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
PY
fi

bash "${ROOT_DIR}/scripts/oss-doc-sanitize.sh" "${OUT_DIR}"

bash "${ROOT_DIR}/scripts/secret-scan.sh" "${OUT_DIR}"

# Remove files excluded from rsync that may linger from older snapshots (--delete does not drop excluded paths).
rm -rf \
  "${OUT_DIR}/docs/Joshu-SOP" \
  "${OUT_DIR}/docs/hermes-customizations.md" \
  "${OUT_DIR}/docs/joshu-identity.md" \
  "${OUT_DIR}/docs/day0-cold-start.md" \
  "${OUT_DIR}/docs/design/brand-guidelines.md" \
  "${OUT_DIR}/docs/design/joshu-style-guide-v1.png" \
  "${OUT_DIR}/docs/vps-sandbox/first-provisioning-notes.md" \
  "${OUT_DIR}/docs/vps-sandbox/troubleshooting-and-lessons.md" \
  "${OUT_DIR}/docs/vps-sandbox/session-2026-06-11-learning-browser-sync.md" \
  "${OUT_DIR}/docs/vps-sandbox/session-2026-06-30-fleet-image-0.1.30-patrick.md" \
  "${OUT_DIR}/docs/vps-sandbox/hotpatch-running-box.md" \
  "${OUT_DIR}/docs/vps-sandbox/credential-isolation-langfuse-relay.md" \
  "${OUT_DIR}/docs/vps-sandbox/update-hardening-todo.md" \
  "${OUT_DIR}/docs/vps-sandbox/control-plane.md" \
  "${OUT_DIR}/docs/vps-sandbox/twilio-a2p-sms.md" \
  "${OUT_DIR}/docs/vps-sandbox/provider-choices.md" \
  "${OUT_DIR}/.joshu/connectors-providers.env" \
  "${OUT_DIR}/docs/vps-sandbox/voice-think-speak.md" \
  "${OUT_DIR}/docs/vps-sandbox/voice-realtime.md" \
  "${OUT_DIR}/docs/vps-sandbox/web-voice.md" \
  "${OUT_DIR}/docs/vps-sandbox/phone-voice-local-test.md" \
  "${OUT_DIR}/docs/releases" \
  "${OUT_DIR}/arozos/web-overlays" \
  "${OUT_DIR}/.cursor" \
  "${OUT_DIR}/scripts/sync-from-oss.sh" \
  "${OUT_DIR}/scripts/repair-fleet-ea-cron-timezone.sh" \
  "${OUT_DIR}/scripts/hotfix-box-to-0.1.26.sh" \
  "${OUT_DIR}/scripts/sync-hermes-to-vps.sh" \
  "${OUT_DIR}/scripts/sync-hindsight-to-vps.sh" \
  "${OUT_DIR}/scripts/sync-camofox-proxy-to-vps.sh" \
  "${OUT_DIR}/scripts/repair-vps-admin-update.sh" \
  "${OUT_DIR}/scripts/repair-instance-env-drift.sh" \
  "${OUT_DIR}/scripts/refresh-vps-ghcr-login.sh" \
  "${OUT_DIR}/scripts/diff-factory-skill-with-learning.sh" \
  "${OUT_DIR}/scripts/lib/ensure-hermes-learning-git.sh" \
  "${OUT_DIR}/.github/workflows/fleet-sync-check.yml" \
  "${OUT_DIR}/.github/workflows/joshu-sandbox-image.yml" \
  "${OUT_DIR}/deploy/.env.vps.example.oss" \
  2>/dev/null || true

# Drop accidental build artifacts that should never ship publicly.
find "${OUT_DIR}/src" -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' \) \
  ! -path '*/shareChat/teamsBotAssets/*' -delete 2>/dev/null || true
rm -rf "${OUT_DIR}/apps"/*/.cache "${OUT_DIR}/packages"/*/.cache 2>/dev/null || true

DOC_COUNT="$(find "${OUT_DIR}/docs" -type f | wc -l | tr -d ' ')"
echo "[prepare-oss-snapshot] docs in OSS tree: ${DOC_COUNT}"

STALE=0
while IFS= read -r pattern; do
  [[ -z "$pattern" || "$pattern" =~ ^# ]] && continue
  # Scan docs + the public env example for relay / fleet leak patterns.
  if rg -q "$pattern" "${OUT_DIR}/docs" "${OUT_DIR}/deploy/.env.vps.example" 2>/dev/null; then
    echo "[prepare-oss-snapshot] WARN stale doc pattern still present: $pattern" >&2
    STALE=1
  fi
done <<'PATTERNS'
hermes-customizations\.md
Joshu-SOP/
your-org/joshu
joshu-beige\.vercel\.app
vps-sandbox/control-plane-portal\.md
apps/control-plane/
hello\.joshu\.me/api/instances/
JOSHU_SCRAPECREATORS_MODE=relay
credential-isolation-langfuse-relay
twilio-a2p-sms\.md
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
