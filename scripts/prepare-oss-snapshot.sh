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

# docs/releases in joshu-oss holds the OSS release notes, which are written there. Its exclude
# keeps them, because rsync --delete does not remove excluded paths.
# ${arr[@]+"${arr[@]}"}: an empty array is an error under set -u in bash 3.2 (macOS).
rsync -a ${RSYNC_DELETE[@]+"${RSYNC_DELETE[@]}"} \
  --exclude .git \
  --exclude node_modules \
  --exclude __pycache__ \
  --exclude '*.pyc' \
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
  --exclude /marketing/ \
  --exclude /vendor/ \
  --exclude .cursor \
  --exclude .claude \
  --exclude /openspec/ \
  --exclude AGENTS.md \
  --exclude CLAUDE.md \
  --exclude .impeccable \
  --exclude 'arozos/web-overlays' \
  --exclude .git \
  --exclude 'docs/Joshu-SOP' \
  --exclude 'docs/reports' \
  --exclude 'docs/design/brand-guidelines.md' \
  --exclude 'docs/design/joshu-style-guide-v1.png' \
  --exclude 'docs/vps-sandbox/first-provisioning-notes.md' \
  --exclude 'docs/vps-sandbox/troubleshooting-and-lessons.md' \
  --exclude 'docs/vps-sandbox/hotpatch-running-box.md' \
  --exclude 'docs/vps-sandbox/existing-box-image-vs-host.md' \
  --exclude 'docs/vps-sandbox/box-skill-reconcile-on-upgrade.md' \
  --exclude 'scripts/upgrade-fleet-box-image.sh' \
  --exclude 'scripts/fleet-deep-smoke-remote.sh' \
  --exclude 'scripts/migrate-fleet-hindsight-pg17.sh' \
  --exclude 'scripts/repair-fleet-cloud-browser-boot.sh' \
  --exclude 'deploy/Dockerfile.fleet-overlay' \
  --exclude 'scripts/vps-build-fleet-overlay.sh' \
  --exclude 'deploy/Dockerfile.oss-overlay' \
  --exclude 'scripts/vps-build-oss-overlay.sh' \
  --exclude 'docs/vps-sandbox/credential-isolation-langfuse-relay.md' \
  --exclude 'docs/vps-sandbox/control-plane.md' \
  --exclude 'docs/vps-sandbox/twilio-a2p-sms.md' \
  --exclude 'docs/vps-sandbox/provider-choices.md' \
  --exclude 'docs/vps-sandbox/phone-voice-local-test.md' \
  --exclude 'docs/releases' \
  --exclude 'docs/joshu-identity.md' \
  --exclude 'docs/day0-cold-start.md' \
  --exclude 'docs/hermes-customizations.md' \
  --exclude 'scripts/sync-from-oss.sh' \
  --exclude 'scripts/hotpatch-twilio-sms.sh' \
  --exclude 'scripts/hotpatch-sms-canonical-reply-mutex.sh' \
  --exclude 'scripts/hotpatch-last30days-multimodal.sh' \
  --exclude 'scripts/hotpatch-owner-voice.sh' \
  --exclude 'scripts/hotpatch-action-guard-sms.sh' \
  --exclude 'scripts/hotpatch-sms-platform-isolation.sh' \
  --exclude 'scripts/hotpatch-chromium-proxy.sh' \
  --exclude 'scripts/repair-fleet-ea-cron-timezone.sh' \
  --exclude 'scripts/check-fleet-box-vitals.sh' \
  --exclude 'scripts/owner-engagement-audit.py' \
  --exclude 'scripts/lib/owner_engagement_probe.py' \
  --exclude 'scripts/openspec-change-status.mjs' \
  --exclude 'scripts/fleet-boxes.mjs' \
  --exclude 'scripts/lib/box-release.mjs' \
  --exclude 'scripts/release-pr-checks.mjs' \
  --exclude 'scripts/record-pr-verification.sh' \
  --exclude 'scripts/deploy-release.mjs' \
  --exclude 'scripts/box-diagnostics.mjs' \
  --exclude 'scripts/run-scripted-checks.mjs' \
  --exclude 'scripts/outcome-checks-due.mjs' \
  --exclude 'scripts/lib/control-plane.mjs' \
  --exclude 'scripts/test-release-deploy.mjs' \
  --exclude '.github/workflows/deploy.yml' \
  --exclude '.github/workflows/outcome-checks.yml' \
  --exclude '.github/pull_request_template.md' \
  --exclude 'scripts/canary-voice-gemini38.sh' \
  --exclude 'scripts/patrick-travel-booking-owner-selection.md' \
  --exclude 'scripts/sync-fleet-skills-from-image.sh' \
  --exclude 'scripts/hotfix-box-to-0.1.26.sh' \
  --exclude 'scripts/sync-hermes-to-vps.sh' \
  --exclude 'scripts/sync-hindsight-to-vps.sh' \
  --exclude 'scripts/repair-vps-admin-update.sh' \
  --exclude 'scripts/repair-instance-env-drift.sh' \
  --exclude 'scripts/refresh-vps-ghcr-login.sh' \
  --exclude 'scripts/diff-factory-skill-with-learning.sh' \
  --exclude 'scripts/lib/ensure-hermes-learning-git.sh' \
  --exclude '.github/workflows/fleet-sync-check.yml' \
  --exclude '.github/workflows/joshu-sandbox-image.yml' \
  --exclude '.github/workflows/release.yml' \
  --exclude '.github/release-notes-prompt.md' \
  --exclude '.github/workflows/pr-process-checks.yml' \
  --exclude '.github/workflows/claude-pr-review.yml' \
  --exclude '.github/workflows/security-bulletins.yml' \
  --exclude 'scripts/check-pr-process.mjs' \
  --exclude 'docs/ci-checks.md' \
  --exclude 'docs/development-flow.md' \
  --exclude 'deploy/.env.vps.example.oss' \
  --exclude '/README.oss.md' \
  --exclude '/CONTRIBUTING.oss.md' \
  "${ROOT_DIR}/" "${OUT_DIR}/"

# Public doc indexes (curated for joshu-oss).
cp "${ROOT_DIR}/README.oss.md" "${OUT_DIR}/README.md"
cp "${ROOT_DIR}/CONTRIBUTING.oss.md" "${OUT_DIR}/CONTRIBUTING.md"
# In docs/, a file <name>.oss.md is the public copy of <name>.md (for example the self-host
# chapters of the user manual). It replaces <name>.md in the OSS tree.
find "${OUT_DIR}/docs" -type f -name '*.oss.md' -print0 |
  while IFS= read -r -d '' oss_doc; do
    mv "${oss_doc}" "${oss_doc%.oss.md}.md"
  done

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
    if "instanceAgentImageRef" in data:
        data["instanceAgentImageRef"] = f"ghcr.io/db-aeon/joshu-oss-instance-agent:{ver}"
    notes = (data.get("notes") or "").strip()
    if notes.startswith("Fleet "):
        data["notes"] = notes.removeprefix("Fleet ").strip()
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
PY
fi

bash "${ROOT_DIR}/scripts/oss-doc-sanitize.sh" "${OUT_DIR}"

bash "${ROOT_DIR}/scripts/secret-scan.sh" "${OUT_DIR}"

# Remove files excluded from rsync that may linger from older snapshots (--delete does not drop excluded paths).
# OSS-owned files (deploy/Dockerfile.oss-overlay, scripts/vps-build-oss-overlay.sh) are
# excluded above so --delete keeps them; do not list them here.
rm -rf \
  "${OUT_DIR}/docs/vps-sandbox/box-skill-reconcile-on-upgrade.md" \
  "${OUT_DIR}/deploy/Dockerfile.fleet-overlay" \
  "${OUT_DIR}/scripts/vps-build-fleet-overlay.sh" \
  "${OUT_DIR}/docs/Joshu-SOP" \
  "${OUT_DIR}/docs/reports" \
  "${OUT_DIR}/docs/hermes-customizations.md" \
  "${OUT_DIR}/docs/joshu-identity.md" \
  "${OUT_DIR}/docs/day0-cold-start.md" \
  "${OUT_DIR}/docs/design/brand-guidelines.md" \
  "${OUT_DIR}/docs/design/joshu-style-guide-v1.png" \
  "${OUT_DIR}/docs/vps-sandbox/first-provisioning-notes.md" \
  "${OUT_DIR}/docs/vps-sandbox/troubleshooting-and-lessons.md" \
  "${OUT_DIR}/docs/vps-sandbox/hotpatch-running-box.md" \
  "${OUT_DIR}/docs/vps-sandbox/credential-isolation-langfuse-relay.md" \
  "${OUT_DIR}/docs/vps-sandbox/control-plane.md" \
  "${OUT_DIR}/docs/vps-sandbox/twilio-a2p-sms.md" \
  "${OUT_DIR}/docs/vps-sandbox/provider-choices.md" \
  "${OUT_DIR}/.joshu/connectors-providers.env" \
  "${OUT_DIR}/docs/vps-sandbox/phone-voice-local-test.md" \
  "${OUT_DIR}/arozos/web-overlays" \
  "${OUT_DIR}/.cursor" \
  "${OUT_DIR}/openspec" \
  "${OUT_DIR}/scripts/sync-from-oss.sh" \
  "${OUT_DIR}/scripts/hotpatch-twilio-sms.sh" \
  "${OUT_DIR}/scripts/hotpatch-sms-canonical-reply-mutex.sh" \
  "${OUT_DIR}/scripts/hotpatch-last30days-multimodal.sh" \
  "${OUT_DIR}/scripts/hotpatch-owner-voice.sh" \
  "${OUT_DIR}/scripts/hotpatch-action-guard-sms.sh" \
  "${OUT_DIR}/scripts/hotpatch-sms-platform-isolation.sh" \
  "${OUT_DIR}/scripts/hotpatch-chromium-proxy.sh" \
  "${OUT_DIR}/scripts/repair-fleet-ea-cron-timezone.sh" \
  "${OUT_DIR}/scripts/check-fleet-box-vitals.sh" \
  "${OUT_DIR}/scripts/openspec-change-status.mjs" \
  "${OUT_DIR}/scripts/fleet-boxes.mjs" \
  "${OUT_DIR}/scripts/lib/box-release.mjs" \
  "${OUT_DIR}/scripts/release-pr-checks.mjs" \
  "${OUT_DIR}/scripts/record-pr-verification.sh" \
  "${OUT_DIR}/scripts/deploy-release.mjs" \
  "${OUT_DIR}/scripts/box-diagnostics.mjs" \
  "${OUT_DIR}/scripts/run-scripted-checks.mjs" \
  "${OUT_DIR}/scripts/outcome-checks-due.mjs" \
  "${OUT_DIR}/scripts/lib/control-plane.mjs" \
  "${OUT_DIR}/scripts/test-release-deploy.mjs" \
  "${OUT_DIR}/.github/workflows/deploy.yml" \
  "${OUT_DIR}/.github/workflows/outcome-checks.yml" \
  "${OUT_DIR}/.github/pull_request_template.md" \
  "${OUT_DIR}/scripts/canary-voice-gemini38.sh" \
  "${OUT_DIR}/scripts/patrick-travel-booking-owner-selection.md" \
  "${OUT_DIR}/scripts/sync-fleet-skills-from-image.sh" \
  "${OUT_DIR}/scripts/hotfix-box-to-0.1.26.sh" \
  "${OUT_DIR}/scripts/sync-hermes-to-vps.sh" \
  "${OUT_DIR}/scripts/sync-hindsight-to-vps.sh" \
  "${OUT_DIR}/scripts/repair-vps-admin-update.sh" \
  "${OUT_DIR}/scripts/repair-instance-env-drift.sh" \
  "${OUT_DIR}/scripts/refresh-vps-ghcr-login.sh" \
  "${OUT_DIR}/scripts/diff-factory-skill-with-learning.sh" \
  "${OUT_DIR}/scripts/lib/ensure-hermes-learning-git.sh" \
  "${OUT_DIR}/.github/workflows/fleet-sync-check.yml" \
  "${OUT_DIR}/.github/workflows/joshu-sandbox-image.yml" \
  "${OUT_DIR}/.github/workflows/release.yml" \
  "${OUT_DIR}/.github/release-notes-prompt.md" \
  "${OUT_DIR}/.github/workflows/pr-process-checks.yml" \
  "${OUT_DIR}/.github/workflows/claude-pr-review.yml" \
  "${OUT_DIR}/.github/workflows/security-bulletins.yml" \
  "${OUT_DIR}/scripts/check-pr-process.mjs" \
  "${OUT_DIR}/docs/ci-checks.md" \
  "${OUT_DIR}/docs/development-flow.md" \
  "${OUT_DIR}/deploy/.env.vps.example.oss" \
  "${OUT_DIR}/README.oss.md" \
  "${OUT_DIR}/CONTRIBUTING.oss.md" \
  2>/dev/null || true

# openspec/ holds evidence from production boxes (owner and contact names, task ids).
# It must not ship in the OSS tree.
if [[ -e "${OUT_DIR}/openspec" ]]; then
  echo "[prepare-oss-snapshot] error: openspec/ is in the OSS tree" >&2
  exit 1
fi

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
